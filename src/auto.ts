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
} from "@ai16z/eliza";
import { bootstrapPlugin } from "@ai16z/plugin-bootstrap";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { character } from "./character.ts";
import type { DirectClient } from "@ai16z/client-direct";
import yargs from "yargs";
import TwitterManager from "@ai16z/client-twitter";
import { TwitterClientInterface } from "@ai16z/client-twitter";
import Client from "@ai16z/client-twitter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ExtendedSettings {
  secrets?: { [key: string]: string };
  voice?: { model?: string; url?: string };
  model?: string;
  embeddingModel?: string;
  webhook: {
    enabled: boolean;
    url: string;
    logToConsole?: boolean;
  };
  post?: {
    enabled: boolean;
    intervalMin: number;
    intervalMax: number;
    prompt?: string;
  };
}

interface ExtendedCharacter extends Character {
  settings: ExtendedSettings;
}

interface ExtendedRuntime extends AgentRuntime {
  character: ExtendedCharacter;
  generate(options: { type: string; maxLength: number }): Promise<string>;
}

function initializeDatabase(dataDir: string) {
  const db = new PostgresDatabaseAdapter({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Only use this for development/testing
    }
  });
  return db;
}

interface TwitterInteraction {
  start(): Promise<void>;
  handleTwitterInteractions(): Promise<void>;
  handleTweet(tweet: any): Promise<void>;
}

interface TwitterPost {
  start(postImmediately?: boolean): Promise<void>;
  generateNewTweet(): Promise<void>;
}

class TwitterPostClient {
  client: any;
  runtime: IAgentRuntime;

  constructor(client: any, runtime: IAgentRuntime) {
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
      const response = await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: this.runtime.character.settings?.post?.prompt || "Generate a post",
          userId: 'system',
          userName: 'System',
          roomId: this.runtime.character.id
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate tweet: ${await response.text()}`);
      }

      const data = await response.json();
      const content = data[0]?.text;

      if (!content) {
        elizaLogger.error("No content generated for tweet");
        return;
      }

      elizaLogger.success("📝 Generated post:", content);

      // Send to webhook before posting
      await this.sendToWebhook('post_generated', {
        text: content,
        character: this.runtime.character.name,
        timestamp: new Date().toISOString(),
        type: 'scheduled_post'
      });

      if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
        elizaLogger.info(`Dry run: would have posted tweet: ${content}`);
        return;
      }

      // Post the tweet
      const result = await this.client.requestQueue.add(
        async () => await this.client.twitterClient.sendTweet(content)
      );

      const body = await result.json();
      const tweetResult = body.data.create_tweet.tweet_results.result;
      
      // Send successful post to webhook
      await this.sendToWebhook('post_sent', {
        text: content,
        tweet_id: tweetResult.rest_id,
        url: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
        timestamp: new Date().toISOString()
      });

      elizaLogger.success(`Tweet posted: https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`);

    } catch (error) {
      elizaLogger.error("Error generating/sending tweet:", error);
      
      // Send error to webhook
      await this.sendToWebhook('post_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  private async sendToWebhook(type: string, data: any) {
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

    elizaLogger.info('🌐 Attempting to send to webhook:', webhookUrl);
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
      elizaLogger.error("❌ Webhook error:", error);
    }
  }
}

class TwitterInteractionClient {
  client: any;
  runtime: IAgentRuntime;
  private processedTweets: Set<string> = new Set();

  constructor(client: any, runtime: IAgentRuntime) {
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
      const tweetCandidates = (await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20
      )).tweets;

      const uniqueTweetCandidates = [...new Set(tweetCandidates)]
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((tweet) => tweet.userId !== this.client.profile.id);

      for (const tweet of uniqueTweetCandidates) {
        if (!this.client.lastCheckedTweetId || parseInt(tweet.id) > this.client.lastCheckedTweetId) {
          elizaLogger.log("New Tweet found", tweet.permanentUrl);
          
          // Send tweet found to webhook
          await this.sendToWebhook('tweet_found', {
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
          await this.sendToWebhook('conversation_thread', {
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
      await this.sendToWebhook('interaction_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  async handleTweet({ tweet, message, thread }: any) {
    if (tweet.userId === this.client.profile.id) return;

    if (!message.content.text) {
      elizaLogger.log("Skipping Tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }

    elizaLogger.log("Processing Tweet:", tweet.id);
    
    // Send processing status to webhook
    await this.sendToWebhook('tweet_processing', {
      id: tweet.id,
      status: 'started',
      timestamp: new Date().toISOString()
    });

    // Query knowledge
    const query = `${tweet.username} ${tweet.text}`;
    elizaLogger.info("Querying knowledge for:", query);
    
    await this.sendToWebhook('knowledge_query', {
      tweet_id: tweet.id,
      query,
      timestamp: new Date().toISOString()
    });

    // Generate response
    const response = await this.generateResponse(tweet, thread);
    
    if (response.action !== "RESPOND") {
      elizaLogger.log("Not responding to message");
      
      await this.sendToWebhook('response_skipped', {
        tweet_id: tweet.id,
        reason: response.action,
        timestamp: new Date().toISOString()
      });
      
      return response;
    }

    if (response.text) {
      try {
        // Send to webhook before posting
        await this.sendToWebhook('response_generated', {
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
        await this.sendToWebhook('response_sent', {
          original_tweet_id: tweet.id,
          response_tweet_id: tweetResult.rest_id,
          url: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        elizaLogger.error(`Error sending response tweet: ${error}`);
        
        // Send error to webhook
        await this.sendToWebhook('response_error', {
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

  private async sendToWebhook(type: string, data: any) {
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

class TwitterManager {
  client: any;
  post: TwitterPostClient;
  interaction: TwitterInteractionClient;

  constructor(runtime: IAgentRuntime) {
    this.client = new ClientBase(runtime);
    this.post = new TwitterPostClient(this.client, runtime);
    this.interaction = new TwitterInteractionClient(this.client, runtime);
  }

  static async start(runtime: IAgentRuntime) {
    const manager = new TwitterManager(runtime);
    await manager.client.init();
    await manager.post.start();
    await manager.interaction.start();
    return manager;
  }
}

async function initializeClients(
  character: Character,
  runtime: IAgentRuntime
) {
  const clients = [];
  const clientTypes = character.clients?.map((str) => str.toLowerCase()) || [];
  
  elizaLogger.info("Initializing clients for:", clientTypes);

  if (clientTypes.includes("twitter")) {
    try {
      process.env.TWITTER_DRY_RUN = "false";

      elizaLogger.info("Starting Twitter client with credentials:", {
        username: process.env.TWITTER_USERNAME?.substring(0, 3) + "..." || "NOT SET",
        email: process.env.TWITTER_EMAIL?.substring(0, 3) + "..." || "NOT SET",
        password: process.env.TWITTER_PASSWORD ? "[SET]" : "NOT SET",
        dryRun: process.env.TWITTER_DRY_RUN
      });

      // Create our local Twitter handler
      const twitterHandler = await TwitterManager.start(runtime);

      clients.push(twitterHandler);
      elizaLogger.success("✅ Local Twitter handler initialized successfully");
    } catch (error) {
      elizaLogger.error("Failed to initialize Twitter handler:", error);
    }
  }

  return clients;
}

function createAgent(
  character: Character,
  db: IDatabaseAdapter,
  cache: ICacheManager,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name
  );
  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [bootstrapPlugin].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

function intializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
  const cache = new CacheManager(new DbCacheAdapter(db, character.id));
  return cache;
}

async function generateAndSendPost(runtime: ExtendedRuntime) {
  try {
    elizaLogger.info("🎲 Starting post generation process...");
    
    const serverPort = process.env.SERVER_PORT || '3000';
    elizaLogger.info(`🌐 Using server port: ${serverPort}`);
    
    // Generate a post using the runtime's message generation
    const response = await fetch(`http://localhost:${serverPort}/${runtime.character.name}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: runtime.character.settings?.post?.prompt || "Generate a post",
        userId: 'system',
        userName: 'System',
        roomId: runtime.character.id
      })
    });

    if (!response.ok) {
      elizaLogger.error("❌ Failed to generate post:", await response.text());
      return;
    }

    const data = await response.json();
    const post = data[0]?.text;

    if (!post) {
      elizaLogger.error("❌ No post was generated");
      return;
    }

    // Log the generated post
    elizaLogger.success("📝 Generated post:", post);

    // Send to post webhook
    const webhookUrl = process.env.WEBHOOK_URL; // Use default webhook for posts
    if (webhookUrl) {
      elizaLogger.info(`🌐 Attempting to send post to webhook: ${webhookUrl}`);
      
      const payload = {
        event: 'twitter_post_generated',
        data: {
          text: post,
          character: runtime.character.name,
          timestamp: new Date().toISOString(),
          type: 'scheduled_post'
        }
      };
      
      elizaLogger.info("📦 Post webhook payload:", JSON.stringify(payload, null, 2));
      
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  } catch (error) {
    elizaLogger.error("❌ Error in post generation process:", error);
    if (error instanceof Error) {
      elizaLogger.error("Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
  }
}

async function startAgent(character: ExtendedCharacter, directClient: DirectClient) {
  try {
    // Set up logging
    elizaLogger.success("Starting auto-posting agent with webhook URL:", process.env.WEBHOOK_URL);
    
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = process.env.OPENAI_API_KEY;
    const dataDir = path.join(__dirname, "../data");

    // Ensure data directory exists with proper permissions
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    }

    const db = initializeDatabase(dataDir);
    await db.init();

    const cache = intializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token) as ExtendedRuntime;

    await runtime.initialize();
    
    // Initialize clients including Twitter
    elizaLogger.info("Initializing clients...");
    const clients = await initializeClients(character, runtime);
    elizaLogger.info("Initialized clients:", clients.length);

    directClient.registerAgent(runtime);
    
    // Start monitoring Twitter interactions immediately
    await TwitterManager.start(runtime);
    
    // Separate post generation timing using environment variables
    const startPostGeneration = () => {
      // Use environment variables with fallback values
      const intervalMin = parseInt(process.env.POST_INTERVAL_MIN || '1');
      const intervalMax = parseInt(process.env.POST_INTERVAL_MAX || '3');
      
      elizaLogger.info("🎯 Starting post generation cycle");
      elizaLogger.info(`📊 Post generation interval configured: ${intervalMin}-${intervalMax} minutes`);
      
      const generatePost = () => {
        const waitTime = (Math.random() * (intervalMax - intervalMin) + intervalMin) * 60000;
        const nextPostTime = new Date(Date.now() + waitTime);
        
        elizaLogger.info(`⏰ Next post scheduled for: ${nextPostTime.toLocaleString()}`);
        elizaLogger.info(`⏳ Time until next post: ${Math.round(waitTime/1000)} seconds`);
        elizaLogger.info(`📊 Current interval settings: ${intervalMin}-${intervalMax} minutes`);
        
        setTimeout(async () => {
          elizaLogger.info("🎨 Starting scheduled post generation...");
          try {
            await generateAndSendPost(runtime);
            elizaLogger.success("✅ Post generated and sent successfully");
          } catch (error) {
            elizaLogger.error("❌ Error generating post:", error);
          }
          generatePost(); // Schedule next post
        }, waitTime);
      };

      // Generate first post after a short delay
      elizaLogger.info("⏳ Scheduling initial post in 5 seconds...");
      setTimeout(async () => {
        elizaLogger.info("🎨 Generating initial post...");
        try {
          await generateAndSendPost(runtime);
          elizaLogger.success("✅ Initial post generated and sent successfully");
        } catch (error) {
          elizaLogger.error("❌ Error generating initial post:", error);
        }
        generatePost(); // Start the regular cycle
      }, 5000); // Wait 5 seconds before first post
    };

    // Start the post generation cycle
    startPostGeneration();

    elizaLogger.success("✅ Auto-posting agent started successfully");

  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error
    );
    console.error(error);
    throw error;
  }
}

const startAutoAgent = async () => {
  const args = yargs(process.argv.slice(2))
    .option("character", {
      alias: "c",
      type: "string",
      description: "Path to character JSON file (e.g., characters/eliza.character.json)",
    })
    .parseSync();

  const directClient = await DirectClientInterface.start();
  try {
    let selectedCharacter: ExtendedCharacter;
    
    if (args.character) {
      const characterPath = path.resolve(process.cwd(), args.character);
      try {
        const loadedChar = JSON.parse(fs.readFileSync(characterPath, "utf8"));
        // Ensure required base fields exist with all necessary properties
        selectedCharacter = {
          id: stringToUuid(loadedChar.name),
          name: loadedChar.name,
          username: loadedChar.name,
          modelProvider: loadedChar.modelProvider || "openai",
          system: loadedChar.system || `Generate posts in the style of ${loadedChar.name}`,
          bio: loadedChar.bio || [],
          lore: loadedChar.lore || [],
          messageExamples: loadedChar.messageExamples || [],
          postExamples: loadedChar.postExamples || [],
          adjectives: loadedChar.adjectives || [],
          people: loadedChar.people || [],
          topics: loadedChar.topics || [],
          style: loadedChar.style || {
            all: [],
            chat: [],
            post: []
          },
          plugins: loadedChar.plugins || [],
          clients: ["twitter"],  // Add Twitter to clients array
          settings: {
            secrets: loadedChar.settings?.secrets || {},
            voice: loadedChar.settings?.voice || {
              model: "en_US-male-medium"
            },
            webhook: {
              enabled: true,
              url: process.env.WEBHOOK_URL,
              logToConsole: true
            },
            post: {
              enabled: true,
              intervalMin: 1,
              intervalMax: 3,
              prompt: `Generate a tweet-length post that reflects ${loadedChar.name}'s personality and interests. Keep it under 280 characters.`
            }
          }
        } as ExtendedCharacter;
        elizaLogger.success(`Loaded character from ${characterPath}`);
      } catch (e) {
        elizaLogger.error(`Error loading character from ${characterPath}: ${e}`);
        process.exit(1);
      }
    } else {
      selectedCharacter = character as ExtendedCharacter;
      elizaLogger.info("No character specified, using default character");
    }

    // Validate the character configuration
    validateCharacterConfig(selectedCharacter);

    await startAgent(selectedCharacter, directClient as DirectClient);
    elizaLogger.log("Agent is running in auto-post mode. Press Ctrl+C to exit.");
  } catch (error) {
    elizaLogger.error("Error starting auto agent:", error);
    if (error instanceof Error) {
      elizaLogger.error("Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
    process.exit(1);
  }
};

startAutoAgent().catch((error) => {
  elizaLogger.error("Unhandled error in startAutoAgent:", error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  elizaLogger.log("\nGracefully shutting down...");
  process.exit(0);
});

// Add this function to forward logs to webhook
async function forwardToWebhook(type: string, data: any) {
  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    const payload = {
      event: `twitter_${type}`,
      data: {
        ...data,
        timestamp: new Date().toISOString()
      }
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    elizaLogger.info(`📤 Forwarded ${type} to webhook`);
  } catch (error) {
    elizaLogger.error(`❌ Failed to forward ${type} to webhook:`, error);
  }
} 