import { elizaLogger } from "@ai16z/eliza";
import fetch from "node-fetch";

export class WebhookHandler {
  constructor(webhookUrl, logToConsole = true, runtime) {
    this.webhookUrls = {
      post: webhookUrl || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook',
      reply: process.env.WEBHOOK_URL_REPLIES || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/replies',
      mention: process.env.WEBHOOK_URL_MENTIONS || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/mentions',
      dm: process.env.WEBHOOK_URL_DM || process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/dm'
    };
    this.logToConsole = logToConsole;
    this.runtime = runtime;
    this.webhookLogs = [];
  }

  async sendToWebhook(event) {
    try {
      const webhookUrl = this.webhookUrls[event.type] || this.webhookUrls.post;
      
      if (!webhookUrl) {
        elizaLogger.warn(`No webhook URL configured for event type: ${event.type}`);
        return;
      }

      const payload = {
        url: webhookUrl,
        type: event.type,
        timestamp: event.timestamp || Date.now(),
        payload: JSON.stringify(event.data, null, 2)
      };

      if (this.logToConsole) {
        elizaLogger.info('Webhook Outgoing Payload:', JSON.stringify(payload, null, 2));
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event.data)
      });

      const responseData = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text()
      };

      if (this.logToConsole) {
        elizaLogger.info('Webhook Response:', JSON.stringify(responseData, null, 2));
      }

      // Store log
      this.webhookLogs.push({
        timestamp: Date.now(),
        success: response.ok,
        payload,
        response: responseData
      });

      if (response.ok) {
        elizaLogger.success(`Successfully sent ${event.type} event to webhook: ${webhookUrl}`);
      } else {
        throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
      }

      return responseData;
    } catch (error) {
      const errorLog = {
        timestamp: Date.now(),
        type: event.type,
        error: error.message,
        stack: error.stack
      };

      elizaLogger.error('Webhook Error:', errorLog);
      
      // Store error log
      this.webhookLogs.push({
        timestamp: Date.now(),
        success: false,
        error: errorLog
      });

      // Don't throw, just log the error
      return null;
    }
  }

  getWebhookLogs() {
    return this.webhookLogs;
  }
} 