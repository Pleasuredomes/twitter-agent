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

class LocalTwitterClient {
  private runtime: IAgentRuntime;
  private twitterClient: any;
  profile: any;
  private lastCheckedTweetId: number | null = null;
  private processedTweets: Set<string> = new Set();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async init() {
    try {
      elizaLogger.info("🔄 Initializing local Twitter client...");
      
      // Initialize the base Twitter client
      const twitterManager = await TwitterClientInterface.start(this.runtime);
      this.twitterClient = twitterManager.client;
      this.profile = this.twitterClient.profile;

      elizaLogger.success("✅ Twitter client initialized with profile:", {
        username: this.profile?.username,
        id: this.profile?.id
      });

      return this;
    } catch (error) {
      elizaLogger.error("❌ Failed to initialize Twitter client:", error);
      throw error;
    }
  }

  async fetchSearchTweets(query: string, count: number) {
    return await this.twitterClient.fetchSearchTweets(query, count);
  }

  async fetchReplies() {
    return await this.twitterClient.fetchReplies();
  }

  async fetchDirectMessages() {
    return await this.twitterClient.fetchDirectMessages();
  }

  async sendTweet(text: string, replyToId?: string) {
    return await this.twitterClient.sendTweet(text, replyToId);
  }

  async sendDirectMessage(userId: string, text: string) {
    return await this.twitterClient.sendDirectMessage(userId, text);
  }
}

class LocalTwitterHandler {
  private client: LocalTwitterClient;
  private runtime: IAgentRuntime;
  private processedTweets: Set<string> = new Set();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.client = new LocalTwitterClient(runtime);
  }

  async start() {
    await this.client.init();
    this.startMonitoring();
  }

  private startMonitoring() {
    elizaLogger.info("🚀 Starting Twitter monitoring...");
    this.checkInteractions();
  }

  private async checkInteractions() {
    const monitor = async () => {
      try {
        await this.checkNewTweets();
      } catch (error) {
        elizaLogger.error("❌ Error in monitoring cycle:", error);
      }
      // Schedule next check
      setTimeout(monitor, 30000);
    };

    // Start monitoring
    monitor();
  }

  private async checkNewTweets() {
    try {
      const username = this.client.profile?.username;
      if (!username) return;

      // Fetch mentions
      const mentions = await this.client.fetchSearchTweets(`@${username}`, 20);
      if (mentions?.length > 0) {
        for (const tweet of mentions) {
          if (this.processedTweets.has(tweet.id)) continue;
          
          elizaLogger.info("🔍 New Tweet found", tweet.permanentUrl);
          
          // Log and send to webhook
          await this.sendToWebhook('tweet_found', {
            id: tweet.id,
            url: tweet.permanentUrl,
            text: tweet.text,
            author: tweet.author?.username,
            timestamp: new Date().toISOString()
          });

          elizaLogger.info("⚙️ Processing Tweet:", tweet.id);
          
          // Process the tweet
          await this.processTweet(tweet);
          
          this.processedTweets.add(tweet.id);
        }
      }
    } catch (error) {
      elizaLogger.error("❌ Error checking new tweets:", error);
    }
  }

  private async processTweet(tweet: any) {
    try {
      // Send processing status to webhook
      await this.sendToWebhook('tweet_processing', {
        id: tweet.id,
        status: 'started',
        timestamp: new Date().toISOString()
      });

      // Query knowledge
      const query = `${tweet.author?.username} ${tweet.text}`;
      elizaLogger.info("🧠 Querying knowledge for:", query);
      
      await this.sendToWebhook('knowledge_query', {
        tweet_id: tweet.id,
        query,
        timestamp: new Date().toISOString()
      });

      // Generate response
      elizaLogger.info("💭 Generating response...");
      const response = await this.generateResponse(tweet);

      if (response) {
        // Log the response
        elizaLogger.info("✨ Generated response:", response);
        
        // Send to webhook
        await this.sendToWebhook('response_generated', {
          tweet_id: tweet.id,
          original_tweet: tweet,
          response: {
            text: response,
            timestamp: new Date().toISOString()
          }
        });

        // Send the actual tweet
        if (!process.env.TWITTER_DRY_RUN) {
          await this.client.sendTweet(response, tweet.id);
          elizaLogger.success("✅ Response tweet sent");
        }
      } else {
        elizaLogger.info("⏭️ Not responding to message");
        await this.sendToWebhook('response_skipped', {
          tweet_id: tweet.id,
          reason: 'No response generated',
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      elizaLogger.error("❌ Error processing tweet:", error);
      await this.sendToWebhook('processing_error', {
        tweet_id: tweet.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  private async generateResponse(tweet: any): Promise<string | null> {
    try {
      const response = await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: tweet.text,
          userId: tweet.author?.id,
          userName: tweet.author?.username,
          roomId: 'twitter'
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate response: ${await response.text()}`);
      }

      const data = await response.json();
      return data[0]?.text || null;
    } catch (error) {
      elizaLogger.error('❌ Error generating response:', error);
      return null;
    }
  }

  private async sendToWebhook(type: string, data: any) {
    const webhookUrl = this.getWebhookUrl(type);
    if (!webhookUrl) {
      elizaLogger.warn("⚠️ No webhook URL configured for type:", type);
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

  private getWebhookUrl(type: string): string | undefined {
    const typeSpecificUrl = {
      tweet_found: process.env.WEBHOOK_URL_TWEETS,
      tweet_processing: process.env.WEBHOOK_URL_TWEETS,
      knowledge_query: process.env.WEBHOOK_URL_TWEETS,
      response_generated: process.env.WEBHOOK_URL_TWEETS,
      response_skipped: process.env.WEBHOOK_URL_TWEETS,
      processing_error: process.env.WEBHOOK_URL_TWEETS
    }[type];

    return typeSpecificUrl || process.env.WEBHOOK_URL;
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
      const twitterHandler = new LocalTwitterHandler(runtime);
      await twitterHandler.start();

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
    new MonitorOnlyTwitterManager(runtime);
    
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