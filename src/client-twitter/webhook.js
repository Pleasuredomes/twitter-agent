import { elizaLogger } from "@ai16z/eliza";
import fetch from "node-fetch";

export class WebhookHandler {
  constructor(webhookUrl, logToConsole = true, runtime) {
    // Set up webhook URLs for content storage and approval system
    this.webhookUrls = {
      // Content Storage URLs
      post: process.env.MAKE_WEBHOOK_URL_POSTS,
      reply: process.env.MAKE_WEBHOOK_URL_INTERACTIONS,
      mention: process.env.MAKE_WEBHOOK_URL_INTERACTIONS,
      dm: process.env.MAKE_WEBHOOK_URL_INTERACTIONS,
      interaction: process.env.MAKE_WEBHOOK_URL_INTERACTIONS,
      error: process.env.MAKE_WEBHOOK_URL_INTERACTIONS,
      
      // Approval System URLs
      approval: process.env.MAKE_WEBHOOK_URL_APPROVAL_REQUEST,
      approval_checks: process.env.MAKE_WEBHOOK_URL_APPROVAL_CHECKS
    };

    // Validate webhook URLs
    Object.entries(this.webhookUrls).forEach(([type, url]) => {
      if (!url) {
        elizaLogger.error(`Missing webhook URL for type: ${type}`);
      }
    });

    this.logToConsole = logToConsole;
    this.runtime = runtime;
    this.pendingApprovals = new Map();
    
    // Start polling for approvals
    this.startPollingApprovals();
  }

  // Poll Airtable for approvals via Make webhook
  async startPollingApprovals() {
    const checkApprovals = async () => {
      try {
        elizaLogger.log('Checking for approvals...');
        
        // Clean and prepare the payload
        const payload = {
          type: 'check_approvals',
          data: {
            agent: {
              name: this.runtime.character.name,
              username: this.runtime.getSetting("TWITTER_USERNAME")
            }
          },
          timestamp: Date.now()
        };

        // Send request to Make to check for approvals
        const response = await fetch(this.webhookUrls.approval_checks, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const responseText = await response.text();
          let approvals;
          
          try {
            // Clean the response text before parsing
            const cleanedText = responseText
              .replace(/[\n\r]/g, '\\n') // Replace newlines with escaped newlines
              .replace(/[\t]/g, '\\t')   // Replace tabs with escaped tabs
              .replace(/\s+/g, ' ')      // Normalize whitespace
              .replace(/\\/g, '\\\\')    // Escape backslashes
              .replace(/"/g, '\\"');     // Escape quotes
            
            elizaLogger.log('Cleaned response text:', cleanedText);
            
            try {
              approvals = JSON.parse(cleanedText);
            } catch (secondError) {
              // If that fails, try parsing the original text
              approvals = JSON.parse(responseText);
            }
          } catch (parseError) {
            elizaLogger.error('Failed to parse approvals response:', {
              responseText,
              error: parseError.message
            });
          }

          if (approvals && Array.isArray(approvals)) {
            elizaLogger.log('Received approvals:', approvals);
            
            // Process each approval
            for (const approval of approvals) {
              const { approval_id, approved, modified_content, reason } = approval;
              
              elizaLogger.log('Processing approval:', {
                approval_id,
                approved,
                has_modified_content: !!modified_content,
                reason
              });

              if (!approval_id) {
                elizaLogger.error('Received approval without approval_id:', approval);
                continue;
              }

              await this.handleApprovalResponse(
                approval_id,
                approved,
                modified_content ? String(modified_content).trim() : null,
                reason ? String(reason).trim() : ''
              );
            }
          } else {
            elizaLogger.log('No new approvals to process');
          }
        } else {
          const errorText = await response.text();
          elizaLogger.error('Error response from approval check:', {
            status: response.status,
            error: errorText
          });
        }
      } catch (error) {
        elizaLogger.error('Error checking approvals:', error);
      } finally {
        // Always schedule the next check, even if there was an error
        setTimeout(checkApprovals, 30000);
        elizaLogger.log('Next approval check scheduled in 30 seconds');
      }
    };

    // Start the polling loop immediately
    elizaLogger.log('Starting approval polling...');
    checkApprovals();
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

      const approvalPayload = {
        type: 'approval_request',
        data: {
          approval_id: approvalId,
          content_type: type,
          content: formattedContent,
          context: typeof context === 'object' ? JSON.stringify(context) : context,
          agent: {
            name: this.runtime.character.name,
            username: this.runtime.getSetting("TWITTER_USERNAME")
          }
        },
        timestamp: Date.now()
      };

      elizaLogger.log('Queuing content for approval:', {
        approvalId,
        type,
        content: formattedContent,
        context: context
      });

      // Store in pending queue
      this.pendingApprovals.set(approvalId, {
        payload: approvalPayload,
        status: 'pending',
        timestamp: Date.now()
      });

      // Send to Make webhook
      const response = await fetch(this.webhookUrls.approval, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(approvalPayload)
      });

      if (!response.ok) {
        throw new Error(`Failed to queue for approval with status ${response.status}`);
      }

      // Store in cache for persistence
      await this.runtime.cacheManager.set(
        `pending_approvals/${approvalId}`,
        {
          payload: approvalPayload,
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

  // Handle an approval response from airtable/webhook
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
        modifiedContent: modifiedContent || (pending?.payload?.data?.content),
        reason,
        approvalId
      };

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

      // Log the approval/rejection
      elizaLogger.log(`Content ${approved ? 'approved' : 'rejected'} for ID: ${approvalId}`, {
        reason,
        modifiedContent: modifiedContent ? 'modified' : 'unchanged',
        originalContent: pending?.payload?.data?.content
      });

      // If approved, post to Twitter
      if (approved && pending?.payload?.data) {
        const { content_type, content } = pending.payload.data;
        const finalContent = modifiedContent || content;

        elizaLogger.log('Posting approved content to Twitter:', {
          type: content_type,
          content: finalContent
        });

        try {
          // Emit the approved event for the runtime to handle
          await this.runtime.emit('content_approved', {
            type: content_type,
            content: finalContent,
            context: pending.payload.data.context,
            approvalId
          });
        } catch (error) {
          elizaLogger.error('Error posting approved content to Twitter:', error);
        }
      }

      return result;
    } catch (error) {
      elizaLogger.error('Error handling approval response:', error);
      throw error;
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

  async sendToWebhook(event) {
    try {
      // Get the appropriate webhook URL for the event type
      const webhookUrl = this.webhookUrls[event.type];
      
      if (!webhookUrl) {
        elizaLogger.error(`No webhook URL configured for event type: ${event.type}`);
        return;
      }

      // Log the outgoing payload
      elizaLogger.log('Webhook Outgoing Payload:', {
        url: webhookUrl,
        type: event.type,
        timestamp: new Date(event.timestamp).toISOString(),
        payload: JSON.stringify(event, null, 2)
      });

      // Send to storage webhook
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event)
      });

      // Also send to approval webhook if it's a content type that needs approval
      if (['post', 'reply', 'mention', 'dm'].includes(event.type)) {
        // Format content and context based on event type
        let formattedContent = '';
        let formattedContext = {};

        switch (event.type) {
          case 'post':
            formattedContent = event.data.text || event.data.content || '';
            break;
          
          case 'reply':
            formattedContent = event.data.text || event.data.content || '';
            formattedContext = {
              in_reply_to: event.data.in_reply_to,
              conversation_id: event.data.conversation_id
            };
            break;
          
          case 'mention':
            formattedContent = event.data.text || event.data.content || '';
            formattedContext = {
              tweet_id: event.data.tweet_id,
              user: event.data.user
            };
            break;
          
          case 'dm':
            formattedContent = event.data.text || event.data.content || '';
            formattedContext = {
              conversation_id: event.data.conversation_id,
              recipient: event.data.recipient
            };
            break;
        }

        // Log the content being sent for approval
        elizaLogger.log('Sending content for approval:', {
          type: event.type,
          content: formattedContent,
          context: formattedContext
        });

        await this.queueForApproval(
          formattedContent,
          event.type,
          {
            ...formattedContext,
            original_event: event.type,
            timestamp: event.timestamp
          }
        );
      }

      // Log the response
      const responseBody = await response.text();
      elizaLogger.log('Webhook Response:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed with status ${response.status}: ${responseBody}`);
      }

      elizaLogger.log(`Successfully sent ${event.type} event to webhook: ${webhookUrl}`);

      // Store webhook logs in cache for debugging
      await this.storeWebhookLog({
        timestamp: event.timestamp,
        type: event.type,
        url: webhookUrl,
        payload: event,
        response: {
          status: response.status,
          statusText: response.statusText,
          body: responseBody
        }
      });

    } catch (error) {
      elizaLogger.error('Error sending webhook notification:', error);
      
      // Store failed webhook attempt in cache
      await this.storeWebhookLog({
        timestamp: event.timestamp,
        type: event.type,
        url: this.webhookUrls[event.type],
        payload: event,
        error: error.message
      });
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
} 