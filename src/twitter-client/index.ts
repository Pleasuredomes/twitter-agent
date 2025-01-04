import { IAgentRuntime, elizaLogger } from "@ai16z/eliza";
import { TwitterClient } from './client';
import { TwitterPostClient } from './post';
import { TwitterInteractionClient } from './interactions';
import { validateTwitterConfig } from './client';

export * from './types';
export * from './client';
export * from './post';
export * from './interactions';

export const TwitterClientInterface = {
  async start(runtime: IAgentRuntime) {
    await validateTwitterConfig(runtime);
    elizaLogger.info("🚀 Starting Twitter client...");
    
    const client = new TwitterClient(runtime);
    await client.init();
    
    const post = new TwitterPostClient(client);
    await post.start();
    
    const interaction = new TwitterInteractionClient(client);
    await interaction.start();
    
    return client;
  },

  async stop(runtime: IAgentRuntime) {
    elizaLogger.warn("⚠️ Twitter client does not support stopping yet");
  }
}; 