import { elizaLogger } from "@ai16z/eliza";
import fetch from "node-fetch";

export class WebhookHandler {
  constructor(webhookUrl, logToConsole = true, runtime) {
    // Set up different webhook URLs for each event type
    this.webhookUrls = {
      post: webhookUrl || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook',
      reply: process.env.WEBHOOK_URL_REPLIES || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/replies',
      mention: process.env.WEBHOOK_URL_MENTIONS || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/mentions',
      dm: process.env.WEBHOOK_URL_DM || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/dm',
      interaction: process.env.WEBHOOK_URL_REPLIES || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/replies',
      error: webhookUrl || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook',
      approval: process.env.WEBHOOK_URL_APPROVAL || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/approval'
    };
    this.logToConsole = logToConsole;
    this.runtime = runtime;
    this.pendingApprovals = new Map();
    this.approvalCallbacks = new Map();
  }

  // Add a new tweet to pending queue and return a promise that will resolve when approved
  async queueForApproval(content, type, context = {}) {
    try {
      const approvalId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const approvalPayload = {
        type: 'approval_request',
        data: {
          approval_id: approvalId,
          content_type: type,
          content,
          context,
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
        content: typeof content === 'string' ? content : JSON.stringify(content)
      });

      // Store in pending queue
      this.pendingApprovals.set(approvalId, {
        payload: approvalPayload,
        status: 'pending',
        timestamp: Date.now()
      });

      // Send to webhook
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

      // Return the approval ID for tracking
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
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      elizaLogger.error(`No pending approval found for ID: ${approvalId}`);
      return;
    }

    const result = {
      approved,
      modifiedContent: modifiedContent || pending.payload.data.content,
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
      modifiedContent: modifiedContent ? 'modified' : 'unchanged'
    });

    return result;
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

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event)
      });

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