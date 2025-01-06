import { elizaLogger } from "@ai16z/eliza";
import { z } from "zod";
import { validateTwitterConfig } from './environment';
import { TwitterManager } from './base';

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

export const TwitterClientInterface = {
  async start(runtime) {
    await validateTwitterConfig(runtime);
    elizaLogger.log("Twitter client started");
    twitterManager = new TwitterManager(runtime);
    await twitterManager.client.init();
    await twitterManager.post.start();
    await twitterManager.interaction.start();

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
  },

  // This can be called directly from your Make (Integromat) webhook
  async handleApproval(payload: unknown) {
    try {
      if (!twitterManager) {
        throw new Error('Twitter manager not initialized');
      }

      // Validate the payload
      const validationResult = ApprovalPayloadSchema.safeParse(payload);
      if (!validationResult.success) {
        elizaLogger.error('Invalid approval payload:', validationResult.error);
        return {
          success: false,
          error: 'Invalid payload',
          details: validationResult.error.errors
        };
      }

      const result = await twitterManager.handleAirtableApproval(validationResult.data);
      return {
        success: true,
        ...result
      };
    } catch (error) {
      elizaLogger.error('Error handling approval:', error);
      return {
        success: false,
        error: 'Internal error',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
};

export default TwitterClientInterface;
