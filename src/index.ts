import express from 'express';
import { elizaLogger } from "@ai16z/eliza";
import { z } from "zod";
import { validateTwitterConfig } from './environment';
import { TwitterManager } from './base';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
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

// Endpoint to handle Airtable approval responses
app.post('/api/twitter/approval', async (req, res) => {
  try {
    if (!twitterManager) {
      throw new Error('Twitter manager not initialized');
    }

    // Validate the payload
    const validationResult = ApprovalPayloadSchema.safeParse(req.body);
    if (!validationResult.success) {
      elizaLogger.error('Invalid approval payload:', validationResult.error);
      return res.status(400).json({
        error: 'Invalid payload',
        details: validationResult.error.errors
      });
    }

    const result = await twitterManager.handleAirtableApproval(validationResult.data);
    return res.json(result);
  } catch (error) {
    elizaLogger.error('Error handling approval endpoint:', error);
    return res.status(500).json({
      error: 'Internal server error',
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

    // Start the Express server
    app.listen(PORT, () => {
      elizaLogger.log(`API server listening on port ${PORT}`);
    });

    return twitterManager;
  },
  async stop(runtime) {
    elizaLogger.warn("Twitter client does not support stopping yet");
  }
};

export default TwitterClientInterface;
