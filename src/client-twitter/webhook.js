import { elizaLogger } from "@ai16z/eliza";
import fetch from "node-fetch";

export class WebhookHandler {
  constructor(webhookUrl, logToConsole = true, runtime) {
    // Set up different webhook URLs for each event type
    this.webhookUrls = {
      post: webhookUrl || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook',
      reply: process.env.WEBHOOK_URL_REPLIES || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/replies',
      mention: process.env.WEBHOOK_URL_MENTIONS || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/mentions',
      dm: process.env.WEBHOOK_URL_DM || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/dm'
    };
    this.logToConsole = logToConsole;
    this.runtime = runtime;
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