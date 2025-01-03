import { PostgresDatabaseAdapter } from "@ai16z/adapter-postgres";
import { SqliteDatabaseAdapter } from "@ai16z/adapter-sqlite";
import { DirectClientInterface } from "@ai16z/client-direct";
import {
  DbCacheAdapter,
  defaultCharacter,
  FsCacheAdapter,
  ICacheManager,
  IDatabaseCacheAdapter,
  stringToUuid,
  AgentRuntime,
  CacheManager,
  Character,
  IAgentRuntime,
  ModelProviderName,
  elizaLogger,
  settings,
  IDatabaseAdapter,
  validateCharacterConfig,
  embeddingZeroVector,
  composeContext,
  generateText,
  ModelClass,
} from "@ai16z/eliza";
import { bootstrapPlugin } from "@ai16z/plugin-bootstrap";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { character } from "./character.ts";
import type { DirectClient } from "@ai16z/client-direct";
import yargs from "yargs";
import { EventEmitter } from "events";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Twitter environment schema validation
const twitterEnvSchema = z.object({
  TWITTER_DRY_RUN: z.string().transform((val) => val.toLowerCase() === "true"),
  TWITTER_USERNAME: z.string().min(1, "Twitter username is required"),
  TWITTER_PASSWORD: z.string().min(1, "Twitter password is required"),
  TWITTER_EMAIL: z.string().email("Valid Twitter email is required"),
  TWITTER_COOKIES: z.string().optional()
});

async function validateTwitterConfig(runtime: IAgentRuntime) {
  try {
    const config = {
      TWITTER_DRY_RUN: runtime.getSetting("TWITTER_DRY_RUN") || process.env.TWITTER_DRY_RUN,
      TWITTER_USERNAME: runtime.getSetting("TWITTER_USERNAME") || process.env.TWITTER_USERNAME,
      TWITTER_PASSWORD: runtime.getSetting("TWITTER_PASSWORD") || process.env.TWITTER_PASSWORD,
      TWITTER_EMAIL: runtime.getSetting("TWITTER_EMAIL") || process.env.TWITTER_EMAIL,
      TWITTER_COOKIES: runtime.getSetting("TWITTER_COOKIES") || process.env.TWITTER_COOKIES
    };
    return twitterEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      throw new Error(
        `Twitter configuration validation failed:\n${errorMessages}`
      );
    }
    throw error;
  }
}

// Request queue for rate limiting
class RequestQueue {
  private queue: (() => Promise<any>)[] = [];
  private processing = false;

  async add(request: () => Promise<any>) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      try {
        await request();
      } catch (error) {
        console.error("Error processing request:", error);
        this.queue.unshift(request);
        await this.exponentialBackoff(this.queue.length);
      }
      await this.randomDelay();
    }
    this.processing = false;
  }

  private async exponentialBackoff(retryCount: number) {
    const delay = Math.pow(2, retryCount) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async randomDelay() {
    const delay = Math.floor(Math.random() * 2000) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// Add interfaces for type safety
interface TwitterCookies {
  key: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

interface TwitterProfile {
  id: string;
  username: string;
  screenName: string;
  bio: string;
  nicknames: string[];
}

interface TwitterTweet {
  id: string;
  name: string;
  username: string;
  text: string;
  conversationId: string;
  createdAt: string;
  userId: string;
  inReplyToStatusId?: string;
  permanentUrl: string;
  timestamp: number;
  hashtags: string[];
  mentions: string[];
  photos: string[];
  thread: any[];
  urls: string[];
  videos: string[];
}

// Add interfaces for API responses
interface TwitterApiResponse {
  json(): Promise<{
    data: {
      create_tweet: {
        tweet_results: {
          result: {
            rest_id: string;
            legacy: {
              full_text: string;
              conversation_id_str: string;
              created_at: string;
              in_reply_to_status_id_str?: string;
              user_id_str: string;
            }
          }
        }
      }
    }
  }>;
}

interface TwitterSearchResponse {
  tweets: TwitterTweet[];
}

// Base Twitter client
class TwitterClient extends EventEmitter {
  private static _twitterClient: any;
  twitterClient: any;
  runtime: IAgentRuntime;
  directions: string;
  lastCheckedTweetId: number | null = null;
  temperature = 0.5;
  requestQueue = new RequestQueue();
  profile!: TwitterProfile;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    this.directions = "- " + this.runtime.character.style.all.join("\n- ") + "- " + this.runtime.character.style.post.join();
    this.initializeProfile();
  }

  private initializeProfile() {
    const username = this.runtime.getSetting("TWITTER_USERNAME");
    if (!username) {
      throw new Error("Twitter username not configured");
    }

    this.profile = {
      id: 'default',
      username,
      screenName: this.runtime.character.name,
      bio: typeof this.runtime.character.bio === "string" ? 
        this.runtime.character.bio : 
        this.runtime.character.bio.length > 0 ? 
          this.runtime.character.bio[0] : "",
      nicknames: []
    };
  }

  async init() {
    const username = this.runtime.getSetting("TWITTER_USERNAME");
    if (!username) {
      throw new Error("Twitter username not configured");
    }

    if (this.runtime.getSetting("TWITTER_COOKIES")) {
      const cookiesArray = JSON.parse(
        this.runtime.getSetting("TWITTER_COOKIES")
      );
      await this.setCookiesFromArray(cookiesArray);
    } else {
      const cachedCookies = await this.getCachedCookies(username);
      if (cachedCookies) {
        await this.setCookiesFromArray(cachedCookies);
      }
    }

    elizaLogger.log("Waiting for Twitter login");
    while (true) {
      await this.login(
        username,
        this.runtime.getSetting("TWITTER_PASSWORD"),
        this.runtime.getSetting("TWITTER_EMAIL")
      );
      if (await this.isLoggedIn()) {
        const cookies = await this.getCookies();
        await this.cacheCookies(username, cookies);
        break;
      }
      elizaLogger.error("Failed to login to Twitter trying again...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    this.profile = await this.fetchProfile(username);
    if (this.profile) {
      elizaLogger.log("Twitter user ID:", this.profile.id);
      elizaLogger.log(
        "Twitter loaded:",
        JSON.stringify(this.profile, null, 10)
      );
      this.runtime.character.twitterProfile = {
        id: this.profile.id,
        username: this.profile.username,
        screenName: this.profile.screenName,
        bio: this.profile.bio,
        nicknames: this.profile.nicknames
      };
    } else {
      throw new Error("Failed to load profile");
    }

    await this.loadLatestCheckedTweetId();
    await this.populateTimeline();
  }

  // Twitter API methods
  async login(username: string, password: string, email: string) {
    // Implement Twitter login
    elizaLogger.info("Would login with:", { username, email });
    return true;
  }

  async isLoggedIn() {
    // Implement login check
    return true;
  }

  async getCookies() {
    // Implement cookie retrieval
    return [];
  }

  async setCookiesFromArray(cookiesArray: TwitterCookies[]) {
    // Implement cookie setting
  }

  async fetchProfile(username: string): Promise<TwitterProfile> {
    const cached = await this.getCachedProfile(username);
    if (cached) return cached;

    try {
      const profile = await this.requestQueue.add(async () => {
        // Implement profile fetching
        return {
          id: 'mock-id',
          username,
          screenName: this.runtime.character.name,
          bio: typeof this.runtime.character.bio === "string" ? 
            this.runtime.character.bio : 
            this.runtime.character.bio.length > 0 ? 
              this.runtime.character.bio[0] : "",
          nicknames: this.runtime.character.twitterProfile?.nicknames || []
        } as TwitterProfile;
      });

      await this.cacheProfile(profile);
      return profile;
    } catch (error) {
      console.error("Error fetching Twitter profile:", error);
      throw new Error("Failed to fetch Twitter profile");
    }
  }

  // Cache methods
  async getCachedProfile(username: string) {
    return await this.runtime.cacheManager.get(
      `twitter/${username}/profile`
    );
  }

  async cacheProfile(profile: any) {
    await this.runtime.cacheManager.set(
      `twitter/${profile.username}/profile`,
      profile
    );
  }

  async getCachedCookies(username: string): Promise<TwitterCookies[] | null> {
    const cookies = await this.runtime.cacheManager.get(
      `twitter/${username}/cookies`
    );
    return cookies as TwitterCookies[] | null;
  }

  async cacheCookies(username: string, cookies: any) {
    await this.runtime.cacheManager.set(
      `twitter/${username}/cookies`,
      cookies
    );
  }

  async loadLatestCheckedTweetId() {
    const latestCheckedTweetId = await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/latest_checked_tweet_id`
    ) as number | null;
    if (latestCheckedTweetId) {
      this.lastCheckedTweetId = latestCheckedTweetId;
    }
  }

  async cacheLatestCheckedTweetId() {
    if (this.lastCheckedTweetId) {
      await this.runtime.cacheManager.set(
        `twitter/${this.profile.username}/latest_checked_tweet_id`,
        this.lastCheckedTweetId
      );
    }
  }

  // Timeline methods
  async fetchHomeTimeline(count: number) {
    elizaLogger.debug("fetching home timeline");
    // Implement timeline fetching
    return [];
  }

  async getCachedTimeline(): Promise<TwitterTweet[]> {
    const timeline = await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/timeline`
    );
    return timeline as TwitterTweet[] || [];
  }

  async cacheTimeline(timeline: any[]) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/timeline`,
      timeline,
      { expires: 10 * 1000 }
    );
  }

  async populateTimeline() {
    elizaLogger.debug("populating timeline...");
    const timeline = await this.fetchHomeTimeline(50);
    await this.cacheTimeline(timeline);
  }

  // Tweet methods
  async sendTweet(text: string, replyToId?: string): Promise<TwitterApiResponse> {
    // Implement tweet sending
    elizaLogger.info("Would send tweet:", { text, replyToId });
    const mockResponse: TwitterApiResponse = {
      json: async () => ({
        data: {
          create_tweet: {
            tweet_results: {
              result: {
                rest_id: 'mock-tweet-id',
                legacy: {
                  full_text: text,
                  conversation_id_str: 'mock-conversation-id',
                  created_at: new Date().toISOString(),
                  in_reply_to_status_id_str: replyToId,
                  user_id_str: this.profile.id
                }
              }
            }
          }
        }
      })
    };
    return mockResponse;
  }

  async fetchSearchTweets(query: string, count: number): Promise<TwitterSearchResponse> {
    try {
      const timeoutPromise = new Promise<TwitterSearchResponse>(
        (resolve) => setTimeout(() => resolve({ tweets: [] }), 10000)
      );

      const result = await this.requestQueue.add(
        async () => {
          // Implement tweet search
          const mockResponse: TwitterSearchResponse = { tweets: [] };
          return mockResponse;
        }
      );

      const finalResult = await Promise.race([result, timeoutPromise]);
      return finalResult ?? { tweets: [] };
    } catch (error) {
      elizaLogger.error("Error fetching search tweets:", error);
      return { tweets: [] };
    }
  }

  // Webhook integration
  async sendToWebhook(type: string, data: any) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      elizaLogger.warn("⚠️ No webhook URL configured");
      return;
    }

    const payload = {
      event: `twitter_${type}`,
      data: {
        ...data,
        processed_at: new Date().toISOString()
      }
    };

    elizaLogger.info('📤 Sending to webhook:', {
      type,
      url: webhookUrl
    });

    elizaLogger.info('📦 Webhook payload:', JSON.stringify(payload, null, 2));

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
      }

      elizaLogger.success(`✅ Successfully sent ${type} to webhook`);
    } catch (error) {
      elizaLogger.error("❌ Webhook error:", {
        type,
        error: error instanceof Error ? error.message : error
      });
    }
  }

  async cacheTweet(tweet: TwitterTweet) {
    await this.runtime.cacheManager.set(
      `twitter/tweets/${tweet.id}`,
      tweet
    );
  }
}

// Constants for Twitter post generation
const MAX_TWEET_LENGTH = 280;

const twitterPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;

function truncateToCompleteSentence(text: string) {
  if (text.length <= MAX_TWEET_LENGTH) {
    return text;
  }
  const truncatedAtPeriod = text.slice(
    0,
    text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
  );
  if (truncatedAtPeriod.trim().length > 0) {
    return truncatedAtPeriod.trim();
  }
  const truncatedAtSpace = text.slice(
    0,
    text.lastIndexOf(" ", MAX_TWEET_LENGTH)
  );
  if (truncatedAtSpace.trim().length > 0) {
    return truncatedAtSpace.trim() + "...";
  }
  return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}

// Post generation client
class TwitterPostClient {
  client: TwitterClient;
  runtime: IAgentRuntime;

  constructor(client: TwitterClient, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
  }

  async start(postImmediately = false) {
    if (!this.client.profile) {
      await this.client.init();
    }

    const generateNewTweetLoop = async () => {
      const lastPost = await this.runtime.cacheManager.get(
        "twitter/" + this.runtime.getSetting("TWITTER_USERNAME") + "/lastPost"
      );
      const lastPostTimestamp = (lastPost as { timestamp: number })?.timestamp ?? 0;
      const minMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
      const maxMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
      const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1000;

      if (Date.now() > lastPostTimestamp + delay) {
        await this.generateNewTweet();
      }

      setTimeout(() => {
        generateNewTweetLoop();
      }, delay);

      elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };

    if (postImmediately) {
      await this.generateNewTweet();
    }
    generateNewTweetLoop();
  }

  async generateNewTweet() {
    elizaLogger.log("Generating new tweet");
    try {
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );

      let homeTimeline = [];
      const cachedTimeline = await this.client.getCachedTimeline();
      if (cachedTimeline) {
        homeTimeline = cachedTimeline;
      } else {
        homeTimeline = await this.client.fetchHomeTimeline(10);
        await this.client.cacheTimeline(homeTimeline);
      }

      const formattedHomeTimeline = `# ${this.runtime.character.name}'s Home Timeline\n\n` + 
        homeTimeline.map((tweet: any) => {
          return `#${tweet.id}
${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? `
In reply to: ${tweet.inReplyToStatusId}` : ""}
${new Date(tweet.timestamp).toDateString()}

${tweet.text}
---
`;
        }).join("\n");

      const topics = this.runtime.character.topics.join(", ");
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid("twitter_generate_room"),
          agentId: this.runtime.agentId,
          content: {
            text: topics,
            action: ""
          }
        },
        {
          twitterUserName: this.client.profile.username,
          timeline: formattedHomeTimeline
        }
      );

      const context = composeContext({
        state,
        template: this.runtime.character.templates?.twitterPostTemplate || twitterPostTemplate
      });

      elizaLogger.debug("generate post prompt:\n" + context);

      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL
      });

      const formattedTweet = newTweetContent.replaceAll(/\\n/g, "\n").trim();
      const content = truncateToCompleteSentence(formattedTweet);

      if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
        elizaLogger.info(`Dry run: would have posted tweet: ${content}`);
        return;
      }

      try {
        elizaLogger.log(`Posting new tweet:\n ${content}`);

        // Send to webhook before posting
        await this.client.sendToWebhook('post_generated', {
          text: content,
          character: this.runtime.character.name,
          timestamp: new Date().toISOString(),
          type: 'scheduled_post'
        });

        const tweetResponse = await this.client.sendTweet(content);
        const body = await tweetResponse.json();
        const tweetResult = body.data.create_tweet.tweet_results.result;

        const tweet: TwitterTweet = {
          id: tweetResult.rest_id,
          name: this.client.profile.screenName,
          username: this.client.profile.username,
          text: tweetResult.legacy.full_text,
          conversationId: tweetResult.legacy.conversation_id_str,
          createdAt: tweetResult.legacy.created_at,
          userId: tweetResult.legacy.user_id_str,
          inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
          permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
          timestamp: new Date(tweetResult.legacy.created_at).getTime(),
          hashtags: [],
          mentions: [],
          photos: [],
          thread: [],
          urls: [],
          videos: []
        };

        await this.runtime.cacheManager.set(
          `twitter/${this.client.profile.username}/lastPost`,
          {
            id: tweet.id,
            timestamp: Date.now()
          }
        );

        await this.client.cacheTweet(tweet);
        homeTimeline.push(tweet);
        await this.client.cacheTimeline(homeTimeline);

        // Send successful post to webhook
        await this.client.sendToWebhook('post_sent', {
          text: content,
          tweet_id: tweetResult.rest_id,
          url: tweet.permanentUrl,
          timestamp: new Date().toISOString()
        });

        elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        const roomId = stringToUuid(
          tweet.conversationId + "-" + this.runtime.agentId
        );

        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureParticipantInRoom(
          this.runtime.agentId,
          roomId
        );

        await this.runtime.messageManager.createMemory({
          id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
          userId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          content: {
            text: newTweetContent.trim(),
            url: tweet.permanentUrl,
            source: "twitter"
          },
          roomId,
          embedding: embeddingZeroVector,
          createdAt: new Date(tweet.createdAt).getTime()
        });

      } catch (error) {
        elizaLogger.error("Error sending tweet:", error);
        
        // Send error to webhook
        await this.client.sendToWebhook('post_error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      elizaLogger.error("Error generating new tweet:", error);
    }
  }
}

// Interaction handling client
class TwitterInteractionClient {
  client: TwitterClient;
  runtime: IAgentRuntime;
  private processedTweets: Set<string> = new Set();

  constructor(client: TwitterClient, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
  }

  async start() {
    const handleTwitterInteractionsLoop = () => {
      this.handleTwitterInteractions();
      setTimeout(
        handleTwitterInteractionsLoop,
        (Math.floor(Math.random() * (5 - 2 + 1)) + 2) * 60 * 1000
      );
    };
    handleTwitterInteractionsLoop();
  }

  async handleTwitterInteractions() {
    elizaLogger.log("Checking Twitter interactions");
    const twitterUsername = this.client.profile.username;
    
    try {
      const searchResponse = await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20
      );

      const uniqueTweetCandidates = [...new Set(searchResponse.tweets)]
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((tweet) => tweet.userId !== this.client.profile.id);

      for (const tweet of uniqueTweetCandidates) {
        if (!this.client.lastCheckedTweetId || parseInt(tweet.id) > this.client.lastCheckedTweetId) {
          elizaLogger.log("New Tweet found", tweet.permanentUrl);
          
          // Send tweet found to webhook
          await this.client.sendToWebhook('tweet_found', {
            id: tweet.id,
            url: tweet.permanentUrl,
            text: tweet.text,
            author: tweet.username,
            timestamp: new Date().toISOString()
          });

          const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
          const userIdUUID = tweet.userId === this.client.profile.id ? 
            this.runtime.agentId : 
            stringToUuid(tweet.userId);

          await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            tweet.username,
            tweet.name,
            "twitter"
          );

          const thread = await this.buildConversationThread(tweet);
          
          // Send thread to webhook
          await this.client.sendToWebhook('conversation_thread', {
            tweet_id: tweet.id,
            thread: thread.map(t => ({
              id: t.id,
              text: t.text,
              author: t.username,
              timestamp: t.timestamp
            })),
            timestamp: new Date().toISOString()
          });

          const message = {
            content: { text: tweet.text },
            agentId: this.runtime.agentId,
            userId: userIdUUID,
            roomId
          };

          await this.handleTweet({
            tweet,
            message,
            thread
          });

          this.client.lastCheckedTweetId = parseInt(tweet.id);
        }
      }

      await this.client.cacheLatestCheckedTweetId();
      elizaLogger.log("Finished checking Twitter interactions");
    } catch (error) {
      elizaLogger.error("Error handling Twitter interactions:", error);
      
      // Send error to webhook
      await this.client.sendToWebhook('interaction_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  async handleTweet({ tweet, message, thread }: { tweet: TwitterTweet; message: any; thread: TwitterTweet[] }) {
    if (tweet.userId === this.client.profile.id) return;

    if (!message.content.text) {
      elizaLogger.log("Skipping Tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }

    elizaLogger.log("Processing Tweet:", tweet.id);
    
    // Send processing status to webhook
    await this.client.sendToWebhook('tweet_processing', {
      id: tweet.id,
      status: 'started',
      timestamp: new Date().toISOString()
    });

    // Query knowledge
    const query = `${tweet.username} ${tweet.text}`;
    elizaLogger.info("Querying knowledge for:", query);
    
    await this.client.sendToWebhook('knowledge_query', {
      tweet_id: tweet.id,
      query,
      timestamp: new Date().toISOString()
    });

    // Generate response
    const response = await this.generateResponse(tweet, thread);
    
    if (response.action !== "RESPOND") {
      elizaLogger.log("Not responding to message");
      
      await this.client.sendToWebhook('response_skipped', {
        tweet_id: tweet.id,
        reason: response.action,
        timestamp: new Date().toISOString()
      });
      
      return response;
    }

    if (response.text) {
      try {
        // Send to webhook before posting
        await this.client.sendToWebhook('response_generated', {
          tweet_id: tweet.id,
          original_tweet: tweet,
          response: {
            text: response.text,
            timestamp: new Date().toISOString()
          }
        });

        // Send the tweet
        const result = await this.client.requestQueue.add(
          async () => await this.client.twitterClient.sendTweet(response.text, tweet.id)
        );

        const body = await result.json();
        const tweetResult = body.data.create_tweet.tweet_results.result;
        
        // Send successful response to webhook
        await this.client.sendToWebhook('response_sent', {
          original_tweet_id: tweet.id,
          response_tweet_id: tweetResult.rest_id,
          url: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        elizaLogger.error(`Error sending response tweet: ${error}`);
        
        // Send error to webhook
        await this.client.sendToWebhook('response_error', {
          tweet_id: tweet.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  private async generateResponse(tweet: any, thread: any[]): Promise<any> {
    try {
      const response = await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: tweet.text,
          userId: tweet.author?.id,
          userName: tweet.author?.username,
          roomId: 'twitter',
          context: {
            thread: thread.map(t => ({
              text: t.text,
              author: t.username,
              timestamp: t.timestamp
            }))
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate response: ${await response.text()}`);
      }

      const data = await response.json();
      return {
        text: data[0]?.text,
        action: data[0]?.action || "IGNORE"
      };
    } catch (error) {
      elizaLogger.error('Error generating response:', error);
      return { text: "", action: "IGNORE" };
    }
  }

  async buildConversationThread(tweet: any, maxReplies = 10) {
    const thread = [];
    const visited = new Set();

    const processThread = async (currentTweet: any, depth = 0) => {
      if (!currentTweet || depth >= maxReplies || visited.has(currentTweet.id)) {
        return;
      }

      visited.add(currentTweet.id);
      thread.unshift(currentTweet);

      if (currentTweet.inReplyToStatusId) {
        try {
          const parentTweet = await this.client.twitterClient.getTweet(
            currentTweet.inReplyToStatusId
          );
          if (parentTweet) {
            await processThread(parentTweet, depth + 1);
          }
        } catch (error) {
          elizaLogger.error("Error fetching parent tweet:", error);
        }
      }
    };

    await processThread(tweet);
    return thread;
  }
}

// Main Twitter manager
class TwitterManager {
  client: TwitterClient;
  post: TwitterPostClient;
  interaction: TwitterInteractionClient;

  constructor(runtime: IAgentRuntime) {
    this.client = new TwitterClient(runtime);
    this.post = new TwitterPostClient(this.client, runtime);
    this.interaction = new TwitterInteractionClient(this.client, runtime);
  }

  static async start(runtime: IAgentRuntime) {
    await validateTwitterConfig(runtime);
    elizaLogger.log("Twitter client started");
    const manager = new TwitterManager(runtime);
    await manager.client.init();
    await manager.post.start();
    await manager.interaction.start();
    return manager;
  }
} 