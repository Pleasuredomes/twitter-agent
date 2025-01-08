import { elizaLogger } from "@ai16z/eliza";
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

export class WebhookHandler {
  constructor(webhookUrl, logToConsole = true, runtime) {
    // Google Sheets configuration
    this.sheetsConfig = {
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS || '{}'),
      ranges: {
        posts: 'Posts!A:Z',
        interactions: 'Interactions!A:Z',
        approvals: 'Approvals!A:Z'
      },
      headers: {
        posts: [
          'tweet_id',
          'content',
          'media_urls',
          'timestamp',
          'permanent_url',
          'in_reply_to_id',
          'conversation_id',
          'approval_id',
          'agent_name',
          'agent_username',
          'status'
        ],
        interactions: [
          'type',              // mention, reply, dm, etc
          'tweet_id',          // ID of the incoming tweet
          'content',           // Content of the incoming tweet
          'author_username',   // Username of the tweet author
          'author_name',       // Display name of the tweet author
          'timestamp',         // When the interaction occurred
          'permanent_url',     // URL to the tweet
          'in_reply_to_id',    // ID of the tweet being replied to
          'conversation_id',   // Thread/conversation ID
          'agent_response',    // Our agent's response if any
          'response_tweet_id', // ID of our response tweet if any
          'agent_name',        // Name of our agent
          'agent_username',    // Username of our agent
          'context'           // Additional context as JSON
        ],
        approvals: [
          'approval_id',       // Unique ID for the approval request
          'content_type',      // Type of content (post, reply, mention, dm)
          'content',           // Original content to be approved
          'modified_content',  // Modified content after review (if any)
          'context',          // Additional context as JSON
          'agent_name',       // Name of the agent
          'agent_username',   // Username of the agent
          'status',          // pending/approved/rejected
          'timestamp',       // When the request was created
          'review_timestamp', // When the content was reviewed
          'reviewer',        // Who reviewed the content (optional)
          'reason',          // Reason for approval/rejection
          'tweet_id'         // ID of the resulting tweet (if approved and posted)
        ]
      }
    };

    // Validate Google Sheets config
    if (!this.sheetsConfig.spreadsheetId || !this.sheetsConfig.credentials) {
      elizaLogger.error('Missing Google Sheets configuration');
    }

    // Initialize Google Sheets API
    this.initGoogleSheets();

    this.logToConsole = logToConsole;
    this.runtime = runtime;
    this.pendingApprovals = new Map();
  }

  async initGoogleSheets() {
    try {
      const auth = new GoogleAuth({
        credentials: this.sheetsConfig.credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      this.sheets = google.sheets({ version: 'v4', auth });
      
      // Test the connection
      await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: 'A1'
      }).catch(error => {
        elizaLogger.error('Failed to connect to Google Sheets:', error.message);
        throw new Error('Failed to connect to Google Sheets. Please check your credentials and spreadsheet ID.');
      });

      elizaLogger.log('Successfully connected to Google Sheets');
    } catch (error) {
      elizaLogger.error('Error initializing Google Sheets:', error);
      throw error;
    }
  }

  // Check approval status directly in Google Sheets
  async checkApprovalStatus(approvalId) {
    try {
        elizaLogger.log("🔍 Checking approval status for:", approvalId);
        
        // Get the sheet data
        const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.sheetsConfig.spreadsheetId,
            range: this.sheetsConfig.ranges.approvals,
            valueRenderOption: 'UNFORMATTED_VALUE',
            majorDimension: 'ROWS'
        });

        if (!response.data || !response.data.values) {
            elizaLogger.warn("⚠️ No data found in approvals sheet");
            return null;
        }

        // Get header row to find column indices
        const headers = response.data.values[0];
        const approvalIdCol = headers.indexOf('approval_id');
        const statusCol = headers.indexOf('status');
        const modifiedContentCol = headers.indexOf('modified_content');
        const reasonCol = headers.indexOf('reason');

        if (approvalIdCol === -1) {
            throw new Error('Could not find approval_id column in sheet');
        }

        // Find the row with matching approval ID
        const row = response.data.values.find(row => row[approvalIdCol] === approvalId);
        
        if (!row) {
            elizaLogger.log("ℹ️ No matching approval found for ID:", approvalId);
            return null;
        }

        const status = row[statusCol];
        const modifiedContent = row[modifiedContentCol];
        const reason = row[reasonCol];

        elizaLogger.log("✅ Found approval status:", {
            approvalId,
            status,
            hasModifiedContent: !!modifiedContent,
            reason
        });

        return {
            status,
            modifiedContent,
            reason
        };
    } catch (error) {
        elizaLogger.error("❌ Error checking approval status:", {
            error,
            approvalId,
            spreadsheetId: this.sheetsConfig.spreadsheetId,
            range: this.sheetsConfig.ranges.approvals
        });
        throw error;
    }
  }

  // Queue tweet for approval
  async queueForApproval(content, type, context = {}) {
    try {
      const approvalId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Ensure content is properly formatted
      const formattedContent = typeof content === 'object' ? 
        (content.text || content.toString()) : 
        (content || '');

      // Log the content being queued
      elizaLogger.log('Formatting content for approval:', {
        originalContent: content,
        formattedContent,
        type
      });

      const approvalData = {
        approval_id: approvalId,
        content_type: type,
        content: formattedContent,
        modified_content: '',
        context: typeof context === 'object' ? JSON.stringify(context) : context,
        agent_name: this.runtime.character.name,
        agent_username: this.runtime.getSetting("TWITTER_USERNAME"),
        status: 'pending',
        timestamp: new Date().toISOString(),
        review_timestamp: '',
        reviewer: '',
        reason: '',
        tweet_id: ''
      };

      // Check if headers exist, if not add them
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.approvals.split('!')[0] + '!A1:1'
      });

      if (!response.data.values || response.data.values.length === 0) {
        // Add headers first
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetsConfig.spreadsheetId,
          range: this.sheetsConfig.ranges.approvals,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [this.sheetsConfig.headers.approvals]
          }
        });
      }

      // Add to Google Sheets
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.approvals,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            approvalData.approval_id,
            approvalData.content_type,
            approvalData.content,
            approvalData.modified_content,
            approvalData.context,
            approvalData.agent_name,
            approvalData.agent_username,
            approvalData.status,
            approvalData.timestamp,
            approvalData.review_timestamp,
            approvalData.reviewer,
            approvalData.reason,
            approvalData.tweet_id
          ]]
        }
      });

      // Store in pending queue
      this.pendingApprovals.set(approvalId, {
        payload: approvalData,
        status: 'pending',
        timestamp: Date.now()
      });

      // Store in cache for persistence
      await this.runtime.cacheManager.set(
        `pending_approvals/${approvalId}`,
        {
          payload: approvalData,
          status: 'pending',
          timestamp: Date.now()
        }
      );

      // Start checking status periodically (every 5 minutes)
      const checkStatus = async () => {
        const status = await this.checkApprovalStatus(approvalId);
        if (status.status === 'pending') {
          // Check again in 5 minutes
          setTimeout(checkStatus, 5 * 60 * 1000);
        }
      };

      // Start first check in 5 minutes
      setTimeout(checkStatus, 5 * 60 * 1000);

      return {
        approvalId,
        status: 'pending'
      };

    } catch (error) {
      elizaLogger.error('Error queueing for approval:', error);
      throw error;
    }
  }

  // Handle an approval response from Google Sheets
  async handleApprovalResponse(approvalId, approved, modifiedContent = null, reason = '') {
    try {
      elizaLogger.log('Handling approval response:', {
        approvalId,
        approved,
        hasModifiedContent: !!modifiedContent,
        reason
      });

      // Get the pending approval data
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) {
        // Try to get from cache
        const cached = await this.runtime.cacheManager.get(`pending_approvals/${approvalId}`);
        if (!cached) {
          elizaLogger.error(`No pending approval found for ID: ${approvalId}`);
          return;
        }
        // Restore from cache to pending queue
        this.pendingApprovals.set(approvalId, cached);
      }

      // Update status in Google Sheets
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.approvals
      });

      const rows = response.data.values || [];
      const headers = rows[0] || [];
      const approvalIdIndex = headers.indexOf('approval_id');
      const rowIndex = rows.findIndex(row => row[approvalIdIndex] === approvalId);

      if (rowIndex !== -1) {
        const updateData = [
          approvalId,
          pending?.payload?.content_type,
          pending?.payload?.content,
          modifiedContent || '',
          pending?.payload?.context,
          pending?.payload?.agent_name,
          pending?.payload?.agent_username,
          approved ? 'approved' : 'rejected',
          pending?.payload?.timestamp,
          new Date().toISOString(), // review_timestamp
          '', // reviewer (could be added as a parameter if needed)
          reason || '',
          '' // tweet_id (will be updated after posting)
        ];

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetsConfig.spreadsheetId,
          range: `${this.sheetsConfig.ranges.approvals.split('!')[0]}!A${rowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [updateData]
          }
        });

        // If approved, post to Twitter and update appropriate sheet
        if (approved) {
          try {
            elizaLogger.log('Posting approved content to Twitter...');
            
            const finalContent = modifiedContent || pending?.payload?.content;
            const contentType = pending?.payload?.content_type;
            const context = pending?.payload?.context;

            // Post to Twitter
            const tweetResult = await this.runtime.emit('content_approved', {
              type: contentType,
              content: finalContent,
              context: context,
              approvalId
            });

            if (tweetResult?.tweet_id) {
              // Update the tweet_id in the approvals sheet
              await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.sheetsConfig.spreadsheetId,
                range: `${this.sheetsConfig.ranges.approvals.split('!')[0]}!M${rowIndex + 1}`, // Column M is tweet_id
                valueInputOption: 'RAW',
                requestBody: {
                  values: [[tweetResult.tweet_id]]
                }
              });

              // Move to appropriate sheet based on content type
              const tweetData = {
                id: tweetResult.tweet_id,
                text: finalContent,
                media_urls: tweetResult.media_urls || [],
                permanentUrl: `https://twitter.com/${pending?.payload?.agent_username}/status/${tweetResult.tweet_id}`,
                inReplyToStatusId: context?.inReplyTo,
                conversationId: context?.conversationId,
                approvalId,
                agent_name: pending?.payload?.agent_name,
                agent_username: pending?.payload?.agent_username
              };

              if (contentType === 'post') {
                await this.moveToPostsSheet(tweetData);
              } else {
                const interactionData = {
                  type: contentType,
                  tweet_id: tweetResult.tweet_id,
                  content: finalContent,
                  author_username: context?.author_username,
                  author_name: context?.author_name,
                  permanent_url: tweetData.permanentUrl,
                  in_reply_to_id: context?.inReplyTo,
                  conversation_id: context?.conversationId,
                  agent_response: finalContent,
                  response_tweet_id: tweetResult.tweet_id,
                  agent_name: pending?.payload?.agent_name,
                  agent_username: pending?.payload?.agent_username,
                  context: context
                };
                await this.moveToInteractionsSheet(interactionData);
              }

              elizaLogger.log('Successfully posted to Twitter and updated sheets:', tweetResult.tweet_id);
            }
          } catch (error) {
            elizaLogger.error('Error posting approved content to Twitter:', error);
            throw error;
          }
        }
      }

      // Update status in cache
      await this.runtime.cacheManager.set(
        `pending_approvals/${approvalId}`,
        {
          ...pending,
          status: approved ? 'approved' : 'rejected',
          result: {
            approved,
            modifiedContent: modifiedContent || (pending?.payload?.content),
            reason,
            approvalId
          }
        }
      );

      // Remove from pending queue
      this.pendingApprovals.delete(approvalId);

      elizaLogger.log(`Successfully processed ${approved ? 'approval' : 'rejection'} for ID: ${approvalId}`);
      return {
        approved,
        modifiedContent: modifiedContent || (pending?.payload?.content),
        reason,
        approvalId
      };

    } catch (error) {
      elizaLogger.error('Error handling approval response:', error);
      throw error;
    }
  }

  // Send data to Google Sheets
  async sendToWebhook(event) {
    try {
      // For posts, store in the posts sheet directly
      if (event.type === 'post') {
        const rowData = [
          event.data.id || '',                                  // tweet_id
          event.data.text || event.data.content || '',         // content
          JSON.stringify(event.data.media_urls || []),         // media_urls
          new Date(event.timestamp).toISOString(),             // timestamp
          event.data.permanentUrl || '',                       // permanent_url
          event.data.inReplyToStatusId || '',                  // in_reply_to_id
          event.data.conversation_id || '',                    // conversation_id
          event.data.approvalId || '',                        // approval_id
          this.runtime.character.name,                        // agent_name
          this.runtime.getSetting("TWITTER_USERNAME"),        // agent_username
          'pending_approval'                                  // status
        ];

        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetsConfig.spreadsheetId,
          range: this.sheetsConfig.ranges.posts,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [rowData]
          }
        });

        elizaLogger.log('Post stored in Posts sheet with status pending_approval');
        return;
      }

      // For other types of events (interactions), proceed as normal
      let range = this.sheetsConfig.ranges.interactions;
      const tweet = event.data.incoming_tweet || {};
      const rowData = [
        event.type,                                           // type
        tweet.id || '',                                       // tweet_id
        tweet.text || '',                                     // content
        tweet.username || '',                                 // author_username
        tweet.name || '',                                     // author_name
        new Date(event.timestamp).toISOString(),              // timestamp
        tweet.permanentUrl || '',                             // permanent_url
        tweet.inReplyToStatusId || '',                        // in_reply_to_id
        tweet.conversation_id || '',                          // conversation_id
        event.data.agent_response?.text || '',                // agent_response
        event.data.agent_response?.tweet_id || '',            // response_tweet_id
        this.runtime.character.name,                          // agent_name
        this.runtime.getSetting("TWITTER_USERNAME"),          // agent_username
        JSON.stringify(event.data.context || {})              // context
      ];

      // Append interaction data
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [rowData]
        }
      });

      elizaLogger.log('Successfully sent data to webhook');
    } catch (error) {
      elizaLogger.error('Error sending data to webhook:', error);
      throw error;
    }
  }

  async storeWebhookLog(logData) {
    try {
      const key = `webhook_logs/${logData.type}/${logData.timestamp}`;
      if (this.runtime?.cacheManager) {
        await this.runtime.cacheManager.set(key, logData);
      }
    } catch (error) {
      elizaLogger.error('Error storing webhook log:', error);
    }
  }

  // Check if a specific approval is still pending
  async isApprovalPending(approvalId) {
    const cached = await this.runtime.cacheManager.get(`pending_approvals/${approvalId}`);
    return cached?.status === 'pending';
  }

  // Get the status and result of an approval
  async getApprovalStatus(approvalId) {
    return await this.runtime.cacheManager.get(`pending_approvals/${approvalId}`);
  }

  // Cleanup method to be called periodically
  async cleanup() {
    try {
      // Clear old items from pendingApprovals map
      const now = Date.now();
      for (const [approvalId, data] of this.pendingApprovals.entries()) {
        if (now - data.timestamp > 24 * 60 * 60 * 1000) { // Older than 24 hours
          this.pendingApprovals.delete(approvalId);
        }
      }

      // Clear memory
      global.gc && global.gc();
    } catch (error) {
      elizaLogger.error('Error during cleanup:', error);
    }
  }

  async checkPendingApprovals() {
    try {
      elizaLogger.log('Checking pending approvals...');
      
      // Get all rows from approvals sheet
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.approvals
      });

      if (!response.data.values || response.data.values.length < 2) {
        elizaLogger.log('No approvals to check');
        return;
      }

      const headers = response.data.values[0];
      const approvalIdIndex = headers.indexOf('approval_id');
      const statusIndex = headers.indexOf('status');
      const contentIndex = headers.indexOf('content');
      const modifiedContentIndex = headers.indexOf('modified_content');
      const reasonIndex = headers.indexOf('reason');
      const timestampIndex = headers.indexOf('timestamp');

      // Process each row
      for (const row of response.data.values.slice(1)) {
        const approvalId = row[approvalIdIndex];
        const status = (row[statusIndex] || '').toLowerCase();
        const timestamp = new Date(row[timestampIndex]).getTime();

        // Skip if not pending and not recently approved/rejected
        if (status === 'pending' || Date.now() - timestamp > 24 * 60 * 60 * 1000) {
          continue;
        }

        elizaLogger.log(`Processing ${status} approval ${approvalId}`);

        if (status === 'approved' || status === 'rejected') {
          // Process the approval/rejection
          await this.handleApprovalResponse(
            approvalId,
            status === 'approved',
            row[modifiedContentIndex] || row[contentIndex],
            row[reasonIndex]
          );

          elizaLogger.log(`Processed ${status} for approval ${approvalId}`);
        }
      }

      elizaLogger.log('Finished checking pending approvals');
    } catch (error) {
      elizaLogger.error('Error checking pending approvals:', error);
      throw error;
    }
  }

  // Add this method to handle successful tweet posting
  async moveToPostsSheet(tweetData) {
    try {
      elizaLogger.log('Moving approved tweet to Posts sheet:', tweetData.id);
      
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.posts,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            tweetData.id,                    // tweet_id
            tweetData.text,                  // content
            JSON.stringify(tweetData.media_urls || []), // media_urls
            new Date().toISOString(),        // timestamp
            tweetData.permanentUrl,          // permanent_url
            tweetData.inReplyToStatusId || '', // in_reply_to_id
            tweetData.conversationId || '',   // conversation_id
            tweetData.approvalId || '',      // approval_id
            tweetData.agent_name,            // agent_name
            tweetData.agent_username,        // agent_username
            'posted'                         // status
          ]]
        }
      });

      elizaLogger.log('Successfully moved tweet to Posts sheet:', tweetData.id);
    } catch (error) {
      elizaLogger.error('Error moving tweet to Posts sheet:', error);
      throw error;
    }
  }

  // Add this method to handle successful interaction posting
  async moveToInteractionsSheet(interactionData) {
    try {
      elizaLogger.log('Moving approved interaction to Interactions sheet:', interactionData.tweet_id);
      
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.interactions,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            interactionData.type,              // type
            interactionData.tweet_id,          // tweet_id
            interactionData.content,           // content
            interactionData.author_username,   // author_username
            interactionData.author_name,       // author_name
            new Date().toISOString(),          // timestamp
            interactionData.permanent_url,     // permanent_url
            interactionData.in_reply_to_id,    // in_reply_to_id
            interactionData.conversation_id,   // conversation_id
            interactionData.agent_response,    // agent_response
            interactionData.response_tweet_id, // response_tweet_id
            interactionData.agent_name,        // agent_name
            interactionData.agent_username,    // agent_username
            JSON.stringify(interactionData.context || {}) // context
          ]]
        }
      });

      elizaLogger.log('Successfully moved interaction to Interactions sheet:', interactionData.tweet_id);
    } catch (error) {
      elizaLogger.error('Error moving interaction to Interactions sheet:', error);
      throw error;
    }
  }
} 