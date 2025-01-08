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
    } catch (error) {
      elizaLogger.error('Error initializing Google Sheets:', error);
      throw error;
    }
  }

  // Check approval status directly in Google Sheets
  async checkApprovalStatus(approvalId) {
    try {
      elizaLogger.log('Checking approval status in Google Sheets for:', approvalId);
      
      // Only fetch the specific row we need using a filter formula
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetsConfig.spreadsheetId,
        range: this.sheetsConfig.ranges.approvals,
        valueRenderOption: 'UNFORMATTED_VALUE',
        // Use a filter to only get the row we need
        majorDimension: 'ROWS',
        // Get headers first
        ranges: [
          `${this.sheetsConfig.ranges.approvals.split('!')[0]}!1:1`,
          // Then get matching row using filter
          `${this.sheetsConfig.ranges.approvals.split('!')[0]}!A:Z`
        ]
      });

      if (!response.data.values || response.data.values.length === 0) {
        elizaLogger.error('No data found in approvals sheet');
        return { status: 'pending' };
      }

      const headers = response.data.valueRanges[0].values[0];
      const approvalIdIndex = headers.indexOf('approval_id');
      const statusIndex = headers.indexOf('status');
      const modifiedContentIndex = headers.indexOf('modified_content');
      const reasonIndex = headers.indexOf('reason');

      // Find the specific row for this approval
      const rows = response.data.valueRanges[1].values;
      const record = rows.find(row => row[approvalIdIndex] === approvalId);
      
      if (!record) {
        elizaLogger.error('No record found for approval ID:', approvalId);
        return { status: 'pending' };
      }

      const status = (record[statusIndex] || 'pending').toLowerCase();
      
      if (status !== 'pending') {
        // Process the approval/rejection
        await this.handleApprovalResponse(
          approvalId,
          status === 'approved',
          record[modifiedContentIndex],
          record[reasonIndex]
        );
      }

      // Clear any objects we don't need anymore
      response.data = null;

      return {
        status,
        modified_content: record[modifiedContentIndex],
        reason: record[reasonIndex]
      };

    } catch (error) {
      elizaLogger.error('Error checking approval status:', error);
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

      const result = {
        approved,
        modifiedContent: modifiedContent || (pending?.payload?.content),
        reason,
        approvalId
      };

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

        // If approved, post to Twitter and update Posts sheet
        if (approved) {
          const finalContent = modifiedContent || pending?.payload?.content;
          const context = JSON.parse(pending?.payload?.context || '{}');

          // Emit the approved event for the runtime to handle Twitter posting
          const tweetResult = await this.runtime.emit('content_approved', {
            type: pending?.payload?.content_type,
            content: finalContent,
            context: context,
            approvalId
          });

          if (tweetResult?.tweet_id) {
            // Update the tweet_id in the Approvals sheet
            await this.sheets.spreadsheets.values.update({
              spreadsheetId: this.sheetsConfig.spreadsheetId,
              range: `${this.sheetsConfig.ranges.approvals.split('!')[0]}!M${rowIndex + 1}`, // Column M is tweet_id
              valueInputOption: 'RAW',
              requestBody: {
                values: [[tweetResult.tweet_id]]
              }
            });

            // Add to Posts sheet
            await this.postToSheet(approvalId, finalContent, {
              ...context,
              tweet_id: tweetResult.tweet_id
            });
          }
        }
      }

      // Update status in cache
      await this.runtime.cacheManager.set(
        `pending_approvals/${approvalId}`,
        {
          ...pending,
          status: approved ? 'approved' : 'rejected',
          result
        }
      );

      // Remove from pending queue
      this.pendingApprovals.delete(approvalId);

      return result;
    } catch (error) {
      elizaLogger.error('Error handling approval response:', error);
      throw error;
    }
  }

  // Send data to Google Sheets
  async sendToWebhook(event) {
    try {
      // For posts, we need to queue for approval first
      if (event.type === 'post') {
        const content = event.data.text || event.data.content || '';
        elizaLogger.log('Queueing post for approval:', content);
        
        // Queue for approval first
        const approvalResult = await this.queueForApproval(
          content,
          'post',
          {
            media_urls: event.data.media_urls || [],
            permanent_url: event.data.permanentUrl || '',
            in_reply_to_id: event.data.inReplyToStatusId || '',
            conversation_id: event.data.conversation_id || ''
          }
        );

        // Store approval ID for later reference
        event.data.approvalId = approvalResult.approvalId;
        
        elizaLogger.log('Post queued for approval with ID:', approvalResult.approvalId);
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

      elizaLogger.log(`Successfully sent ${event.type} event to Google Sheets`);

      // Clean up event data we don't need anymore
      event.data = null;

      // Store minimal log data
      await this.storeWebhookLog({
        timestamp: event.timestamp,
        type: event.type,
        spreadsheetId: this.sheetsConfig.spreadsheetId
      });

    } catch (error) {
      elizaLogger.error('Error sending to Google Sheets:', error);
      throw error;
    }
  }

  // Add a new method to handle posting approved content
  async postToSheet(approvalId, content, context = {}) {
    try {
      const rowData = [
        context.tweet_id || '',                              // tweet_id
        content,                                             // content
        JSON.stringify(context.media_urls || []),            // media_urls
        new Date().toISOString(),                           // timestamp
        context.permanent_url || '',                         // permanent_url
        context.in_reply_to_id || '',                       // in_reply_to_id
        context.conversation_id || '',                       // conversation_id
        approvalId,                                         // approval_id
        this.runtime.character.name,                        // agent_name
        this.runtime.getSetting("TWITTER_USERNAME"),        // agent_username
        'approved'                                          // status
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

      elizaLogger.log('Successfully posted approved content to Posts sheet');
    } catch (error) {
      elizaLogger.error('Error posting to Posts sheet:', error);
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
} 