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
        // For mentions, check if we already have a pending approval or have already replied
        if (type === 'mention') {
            const tweetId = context.tweet_id;
            if (tweetId) {
                // Check existing approvals in the approvals sheet
                const approvalsResponse = await this.sheets.spreadsheets.values.get({
                    spreadsheetId: this.sheetsConfig.spreadsheetId,
                    range: this.sheetsConfig.ranges.approvals
                });

                // Check existing interactions in the interactions sheet
                const interactionsResponse = await this.sheets.spreadsheets.values.get({
                    spreadsheetId: this.sheetsConfig.spreadsheetId,
                    range: this.sheetsConfig.ranges.interactions
                });

                let shouldSkip = false;

                // Check approvals sheet for pending or approved entries
                if (approvalsResponse.data.values) {
                    const headers = approvalsResponse.data.values[0];
                    const contextIndex = headers.indexOf('context');
                    const statusIndex = headers.indexOf('status');
                    
                    const existingApproval = approvalsResponse.data.values.slice(1).find(row => {
                        if (!row[contextIndex]) return false;
                        try {
                            const rowContext = JSON.parse(row[contextIndex]);
                            const rowStatus = row[statusIndex]?.toLowerCase();
                            return rowContext.tweet_id === tweetId && 
                                   (rowStatus === 'pending' || rowStatus === 'approved' || rowStatus === 'sent');
                        } catch (e) {
                            return false;
                        }
                    });

                    if (existingApproval) {
                        elizaLogger.log('Skipping duplicate mention approval for tweet:', tweetId);
                        shouldSkip = true;
                    }
                }

                // Check interactions sheet for existing replies
                if (!shouldSkip && interactionsResponse.data.values) {
                    const headers = interactionsResponse.data.values[0];
                    const tweetIdIndex = headers.indexOf('tweet_id');
                    const responseIdIndex = headers.indexOf('response_tweet_id');
                    
                    const existingInteraction = interactionsResponse.data.values.slice(1).find(row => {
                        return row[tweetIdIndex] === tweetId && row[responseIdIndex]; // If we have a response_tweet_id, we've replied
                    });

                    if (existingInteraction) {
                        elizaLogger.log('Skipping mention - already replied to tweet:', tweetId);
                        shouldSkip = true;
                    }
                }

                if (shouldSkip) {
                    return null;
                }
            }
        }

        const approvalId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Format content based on type
        let formattedContent;
        if (type === 'mention' || type === 'reply') {
            // For mentions/replies, include both original tweet and response
            formattedContent = typeof content === 'string' ? content : content.text || '';
        } else {
            // For posts, just use the content directly
            formattedContent = typeof content === 'object' ? 
                (content.text || content.toString()) : 
                (content || '');
        }

        // Log the content being queued
        elizaLogger.log('Formatting content for approval:', {
            originalContent: content,
            formattedContent,
            type,
            context
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
        elizaLogger.log("🔄 Processing approval response:", {
            approvalId,
            approved,
            hasModifiedContent: !!modifiedContent,
            reason
        });

        // Get the pending approval from cache
        elizaLogger.log("🔍 Looking up pending approval...");
        const pendingApproval = await this.runtime.cacheManager.get(`pending_approvals/${approvalId}`);
        
        if (!pendingApproval) {
            elizaLogger.error('❌ No pending approval found in cache:', approvalId);
            return;
        }

        elizaLogger.log("✅ Found pending approval:", pendingApproval);
        const contextData = typeof pendingApproval.payload.context === 'string' ? 
            JSON.parse(pendingApproval.payload.context) : 
            pendingApproval.payload.context;

        if (approved) {
            // Get the content to send
            let tweetContent = typeof modifiedContent === 'string' ? modifiedContent : modifiedContent?.text || pendingApproval.payload.content;
            
            // Extract text from JSON if needed
            if (tweetContent.includes('```json')) {
                try {
                    // Extract the JSON content between the backticks
                    const jsonMatch = tweetContent.match(/```json\s*(.*?)\s*```/s);
                    if (jsonMatch) {
                        const jsonContent = jsonMatch[1].replace(/\\"/g, '"');  // Fix escaped quotes
                        const parsed = JSON.parse(jsonContent);
                        tweetContent = parsed.text;
                    }
                } catch (e) {
                    elizaLogger.warn('Failed to parse JSON content, using as is:', e);
                }
            }
            
            elizaLogger.log("📝 Preparing to post response:", {
                content: tweetContent,
                type: pendingApproval.payload.content_type,
                context: contextData,
                length: tweetContent.length
            });

            try {
                // Get Twitter client from runtime with retries
                let twitterClient = null;
                let retryCount = 0;
                const maxRetries = 3;
                const retryDelay = 5000; // 5 seconds

                while (!twitterClient && retryCount < maxRetries) {
                    // The client is stored directly in the TwitterPostClient instance
                    twitterClient = this.runtime.clients?.find(client => client.post)?.client;
                    
                    if (!twitterClient) {
                        retryCount++;
                        elizaLogger.warn(`⚠️ Twitter client not found in runtime (attempt ${retryCount}/${maxRetries}):`, {
                            hasClients: !!this.runtime.clients,
                            clientKeys: Object.keys(this.runtime.clients || {}),
                            clientCount: this.runtime.clients?.length || 0,
                            clientTypes: this.runtime.clients?.map(c => c.constructor.name) || []
                        });
                        
                        if (retryCount < maxRetries) {
                            elizaLogger.log(`Waiting ${retryDelay/1000} seconds before retry...`);
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                        }
                    }
                }

                if (!twitterClient) {
                    throw new Error(`Twitter client not found in runtime after ${maxRetries} attempts`);
                }

                elizaLogger.log("🔄 Making Twitter API call...");
                let postResult = null;
                retryCount = 0;

                while (!postResult && retryCount < maxRetries) {
                    try {
                        // Get the Twitter client from the post client
                        const twitterClient = this.runtime.clients?.find(client => client.post)?.client?.twitterClient;
                        if (!twitterClient) {
                            throw new Error('Twitter client not found');
                        }

                        elizaLogger.log("📝 Twitter client structure:", {
                            hasClient: !!twitterClient,
                            clientMethods: Object.keys(twitterClient || {}),
                            hasProfile: !!twitterClient.profile,
                            hasSession: !!twitterClient.session,
                            sendTweetMethod: typeof twitterClient.sendTweet,
                            clientState: {
                                isLoggedIn: !!twitterClient.isLoggedIn,
                                username: twitterClient.profile?.username,
                                userId: twitterClient.profile?.userId
                            }
                        });

                        // Use sendTweet method that was working previously
                        if (pendingApproval.payload.content_type === 'mention') {
                            // For mentions, reply to the original tweet
                            const replyToId = contextData?.tweet_id;
                            if (!replyToId) {
                                throw new Error('No tweet_id found for mention reply');
                            }
                            elizaLogger.log("📝 Replying to mention:", {
                                replyToId,
                                content: tweetContent,
                                originalTweet: contextData?.content,
                                fullContext: contextData
                            });

                            // Add @ mention if not present
                            const mentionPrefix = `@${contextData.author_username}`;
                            const finalContent = tweetContent.startsWith(mentionPrefix) ? 
                                tweetContent : 
                                `${mentionPrefix} ${tweetContent}`;

                            postResult = await twitterClient.sendTweet(
                                finalContent,
                                replyToId
                            );

                            elizaLogger.log("✅ Sent reply to mention:", {
                                replyToId,
                                content: finalContent,
                                result: postResult
                            });
                        } else if (pendingApproval.payload.content_type === 'reply') {
                            // For replies, use the in_reply_to_id
                            const replyToId = contextData?.in_reply_to_id;
                            if (!replyToId) {
                                throw new Error('No in_reply_to_id found for reply');
                            }
                            elizaLogger.log("📝 Sending reply:", {
                                replyToId,
                                content: tweetContent
                            });
                            postResult = await twitterClient.sendTweet(
                                tweetContent,
                                replyToId
                            );
                        } else {
                            // For posts, post directly to user's account
                            elizaLogger.log("📝 Posting new tweet:", {
                                content: tweetContent
                            });
                            postResult = await twitterClient.sendTweet(
                                tweetContent
                            );
                        }

                        // Extract the tweet ID from the response if needed
                        if (!postResult.id) {
                            postResult = {
                                id: postResult.tweet_id || postResult.data?.id,
                                conversation_id: postResult.conversation_id || postResult.data?.conversation_id
                            };
                        }
                    } catch (postError) {
                        retryCount++;
                        elizaLogger.warn(`⚠️ Failed to post tweet (attempt ${retryCount}/${maxRetries}):`, {
                            error: postError.message,
                            code: postError.code,
                            response: postError.response?.data
                        });
                        
                        if (retryCount < maxRetries) {
                            elizaLogger.log(`Waiting ${retryDelay/1000} seconds before retry...`);
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                        } else {
                            throw postError;
                        }
                    }
                }

                elizaLogger.log("✅ Twitter API response:", postResult);

                // Update Google Sheet with success status
                await this.updateApprovalStatus(approvalId, 'sent', postResult.id);

                // Handle different content types
                if (pendingApproval.payload.content_type === 'post') {
                    // Move to posts sheet if it was a post
                    await this.moveToPostsSheet({
                        id: postResult.id,
                        text: tweetContent,
                        permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${postResult.id}`,
                        inReplyToStatusId: contextData?.inReplyTo,
                        conversationId: postResult.conversation_id,
                        approvalId: approvalId,
                        agent_name: this.runtime.character.name,
                        agent_username: this.runtime.getSetting("TWITTER_USERNAME")
                    });
                } else {
                    // Move to interactions sheet for mentions, replies, dms
                    await this.moveToInteractionsSheet({
                        type: pendingApproval.payload.content_type,
                        tweet_id: contextData.tweet_id,
                        content: contextData.content,
                        author_username: contextData.author_username,
                        author_name: contextData.author_name,
                        permanent_url: contextData.permanent_url,
                        in_reply_to_id: contextData.tweet_id,
                        conversation_id: postResult.conversation_id,
                        agent_response: tweetContent,
                        response_tweet_id: postResult.id,
                        agent_name: this.runtime.character.name,
                        agent_username: this.runtime.getSetting("TWITTER_USERNAME"),
                        context: contextData
                    });
                }

                elizaLogger.log('✅ Successfully sent approved content:', {
                    approvalId,
                    tweetId: postResult.id,
                    text: tweetContent,
                    type: pendingApproval.payload.content_type
                });

                // Remove from pending approvals
                this.pendingApprovals.delete(approvalId);
                await this.runtime.cacheManager.delete(`pending_approvals/${approvalId}`);

            } catch (error) {
                elizaLogger.error('❌ Error sending to Twitter:', {
                    error: {
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                        code: error.code,
                        response: error.response?.data,
                        status: error.response?.status
                    },
                    content: {
                        text: tweetContent,
                        length: tweetContent.length,
                        type: pendingApproval.payload.content_type,
                        context: contextData
                    },
                    runtime: {
                        hasClients: !!this.runtime.clients,
                        clientKeys: Object.keys(this.runtime.clients || {}),
                        hasTwitter: !!this.runtime.clients?.twitter
                    }
                });

                // Update Google Sheet with error status
                await this.updateApprovalStatus(approvalId, 'error', '', error.message);

                throw error;
            }
        } else {
            // Update Google Sheet with rejected status
            await this.updateApprovalStatus(approvalId, 'rejected', '', reason);

            // Remove from pending approvals
            this.pendingApprovals.delete(approvalId);
            await this.runtime.cacheManager.delete(`pending_approvals/${approvalId}`);

            elizaLogger.log('ℹ️ Content rejected:', {
                approvalId,
                type: pendingApproval.payload.content_type,
                reason
            });
        }
    } catch (error) {
        elizaLogger.error('❌ Error in approval response handler:', {
            error: {
                name: error.name,
                message: error.message,
                stack: error.stack
            },
            context: {
                approvalId,
                approved,
                hasModifiedContent: !!modifiedContent
            }
        });
        throw error;
    }
  }

  // Helper method to update approval status in Google Sheet
  async updateApprovalStatus(approvalId, status, tweetId = '', reason = '') {
    try {
        const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.sheetsConfig.spreadsheetId,
            range: this.sheetsConfig.ranges.approvals
        });

        if (!response.data.values) return;

        const headers = response.data.values[0];
        const approvalIdCol = headers.indexOf('approval_id');
        const statusCol = headers.indexOf('status');
        const tweetIdCol = headers.indexOf('tweet_id');
        const reasonCol = headers.indexOf('reason');
        const reviewTimestampCol = headers.indexOf('review_timestamp');

        const rowIndex = response.data.values.findIndex(row => row[approvalIdCol] === approvalId);
        if (rowIndex === -1) return;

        const range = `${this.sheetsConfig.ranges.approvals.split('!')[0]}!A${rowIndex + 1}:Z${rowIndex + 1}`;
        const row = response.data.values[rowIndex];
        row[statusCol] = status;
        row[tweetIdCol] = tweetId;
        row[reasonCol] = reason;
        row[reviewTimestampCol] = new Date().toISOString();

        await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.sheetsConfig.spreadsheetId,
            range,
            valueInputOption: 'RAW',
            requestBody: {
                values: [row]
            }
        });
    } catch (error) {
        elizaLogger.error('❌ Error updating approval status in sheet:', error);
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
        
        // Verify Twitter client access
        const twitterClient = this.runtime.clients?.find(client => client.post)?.client;
        if (!twitterClient) {
            elizaLogger.warn('Twitter client not available, will retry later:', {
                hasClients: !!this.runtime.clients,
                clientCount: this.runtime.clients?.length || 0,
                clientTypes: this.runtime.clients?.map(c => c.constructor.name) || []
            });
            return; // Exit early and retry on next check
        }
        
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
        const contentTypeIndex = headers.indexOf('content_type');
        const contextIndex = headers.indexOf('context');

        // Process each row
        for (const row of response.data.values.slice(1)) {
            const approvalId = row[approvalIdIndex];
            const status = (row[statusIndex] || '').toLowerCase();
            const timestamp = new Date(row[timestampIndex]).getTime();
            const contentType = row[contentTypeIndex];
            const context = row[contextIndex] ? JSON.parse(row[contextIndex]) : {};

            // Skip if not pending and not recently approved/rejected
            if (status !== 'approved' && status !== 'rejected') {
                continue;
            }

            elizaLogger.log(`Processing ${status} approval ${approvalId}`, {
                approvalId,
                status,
                contentType,
                hasContext: !!context
            });

            // Check if we have this approval in cache
            const cachedApproval = await this.runtime.cacheManager.get(`pending_approvals/${approvalId}`);
            if (!cachedApproval) {
                elizaLogger.log(`Creating cache entry for approval ${approvalId}`);
                // Create a cache entry for this approval
                await this.runtime.cacheManager.set(`pending_approvals/${approvalId}`, {
                    payload: {
                        approval_id: approvalId,
                        content_type: contentType,
                        content: row[contentIndex],
                        context: context,
                        agent_name: this.runtime.character.name,
                        agent_username: this.runtime.getSetting("TWITTER_USERNAME")
                    },
                    status: 'pending',
                    timestamp: timestamp
                });
            }

            // Process the approval/rejection
            await this.handleApprovalResponse(
                approvalId,
                status === 'approved',
                row[modifiedContentIndex] || row[contentIndex],
                row[reasonIndex]
            );

            elizaLogger.log(`Processed ${status} for approval ${approvalId}`);
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