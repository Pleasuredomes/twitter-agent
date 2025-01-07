import { elizaLogger } from "@ai16z/eliza";
import { z } from "zod";
import { validateTwitterConfig } from './environment';
import { TwitterManager } from './base';
import express from 'express';

const app = express();
app.use(express.json());

let twitterManager: TwitterManager | null = null;

// Validation schema for approval payload
const ApprovalPayloadSchema = z.object({
  type: z.literal('approval_response'),
  data: z.object({
    approval_id: z.string(),
    approved: z.union([z.boolean(), z.string()]),
    modified_content: z.string().optional(),
    reason: z.string().optional()
  })
});

// Add webhook endpoint to receive Make responses
app.post('/webhook/approval', async (req, res) => {
  try {
    if (!twitterManager) {
      throw new Error('Twitter manager not initialized');
    }

    // Validate the payload
    const validationResult = ApprovalPayloadSchema.safeParse(req.body);
    if (!validationResult.success) {
      elizaLogger.error('Invalid approval payload:', validationResult.error);
      return res.status(400).json({
        success: false,
        error: 'Invalid payload',
        details: validationResult.error.errors
      });
    }

    const result = await twitterManager.handleAirtableApproval(validationResult.data);
    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    elizaLogger.error('Error handling approval webhook:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export const TwitterClientInterface = {
  async start(runtime) {
    await validateTwitterConfig(runtime);
    elizaLogger.log("Twitter client started");
    twitterManager = new TwitterManager(runtime);
    await twitterManager.client.init();
    await twitterManager.post.start();
    await twitterManager.interaction.start();

    // Start the webhook server
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      elizaLogger.log(`Webhook server listening on port ${port}`);
    });

    // Keep the worker running
    process.on('SIGTERM', () => {
      elizaLogger.log('Received SIGTERM signal, preparing for shutdown...');
      // Add any cleanup logic here
      process.exit(0);
    });

    // Log that we're running
    elizaLogger.log("Twitter background worker is running...");

    return twitterManager;
  },

  async stop(runtime) {
    elizaLogger.warn("Twitter client does not support stopping yet");
  }
};

export default TwitterClientInterface;
