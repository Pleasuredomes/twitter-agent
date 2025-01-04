import { IAgentRuntime } from "@ai16z/eliza";
import { Tweet, TwitterProfile, TweetSearchResult, TweetResponse, WebhookPayload } from "./types";
import { TwitterClient } from "./client";

export { TwitterClient };
export { Tweet, TwitterProfile, TweetSearchResult, TweetResponse, WebhookPayload };

export class TwitterClientInterface {
  static async start(runtime: IAgentRuntime): Promise<TwitterClient> {
    const client = new TwitterClient(runtime);
    await client.init();
    return client;
  }
} 