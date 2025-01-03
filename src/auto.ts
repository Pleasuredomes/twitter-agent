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

class TwitterInteractionHandler {
  private client: any;
  private runtime: any;
  private lastCheckedTweetId: number | null = null;
  private processedTweets: Set<string> = new Set();

  constructor(client: any, runtime: any) {
    this.client = client;
    this.runtime = runtime;
  }

  async start() {
    elizaLogger.info("🚀 Starting Twitter interaction handler...");
    this.handleInteractions();
  }

  private async handleInteractions() {
    const checkInteractions = async () => {
      try {
        elizaLogger.info("👀 Checking Twitter interactions...");
        await this.checkMentions();
        await this.checkReplies();
        await this.checkDirectMessages();
      } catch (error) {
        elizaLogger.error("❌ Error checking interactions:", error);
      }

      // Schedule next check
      setTimeout(checkInteractions, 30000); // Check every 30 seconds
    };

    // Start checking
    checkInteractions();
  }

  private async checkMentions() {
    try {
      const username = this.client.profile?.username;
      if (!username) return;

      elizaLogger.info("🔍 Checking mentions...");
      const mentions = await this.client.fetchSearchTweets(`@${username}`, 20);

      if (mentions?.length > 0) {
        elizaLogger.info(`📨 Found ${mentions.length} mentions`);
        
        for (const mention of mentions) {
          if (this.processedTweets.has(mention.id)) continue;
          
          elizaLogger.info('📝 Processing mention:', {
            id: mention.id,
            author: mention.author?.username,
            text: mention.text
          });

          // Send to webhook
          await this.sendToWebhook('mention', {
            id: mention.id,
            type: 'mention',
            author: mention.author?.username,
            text: mention.text,
            url: mention.permanentUrl,
            timestamp: new Date().toISOString()
          });

          // Generate and send response if needed
          await this.handleResponse(mention);
          
          this.processedTweets.add(mention.id);
        }
      }
    } catch (error) {
      elizaLogger.error("❌ Error checking mentions:", error);
    }
  }

  private async checkReplies() {
    try {
      elizaLogger.info("🔍 Checking replies...");
      const replies = await this.client.fetchReplies();

      if (replies?.length > 0) {
        elizaLogger.info(`📨 Found ${replies.length} replies`);
        
        for (const reply of replies) {
          if (this.processedTweets.has(reply.id)) continue;
          
          elizaLogger.info('📝 Processing reply:', {
            id: reply.id,
            author: reply.author?.username,
            text: reply.text,
            in_reply_to: reply.in_reply_to_status_id
          });

          // Send to webhook
          await this.sendToWebhook('reply', {
            id: reply.id,
            type: 'reply',
            author: reply.author?.username,
            text: reply.text,
            in_reply_to: reply.in_reply_to_status_id,
            url: reply.permanentUrl,
            timestamp: new Date().toISOString()
          });

          // Generate and send response if needed
          await this.handleResponse(reply);
          
          this.processedTweets.add(reply.id);
        }
      }
    } catch (error) {
      elizaLogger.error("❌ Error checking replies:", error);
    }
  }

  private async checkDirectMessages() {
    try {
      elizaLogger.info("🔍 Checking DMs...");
      const messages = await this.client.fetchDirectMessages();

      if (messages?.length > 0) {
        elizaLogger.info(`📨 Found ${messages.length} DMs`);
        
        for (const message of messages) {
          if (this.processedTweets.has(message.id)) continue;
          
          elizaLogger.info('📝 Processing DM:', {
            id: message.id,
            sender: message.sender?.username,
            text: message.text
          });

          // Send to webhook
          await this.sendToWebhook('dm', {
            id: message.id,
            type: 'dm',
            sender: message.sender?.username,
            text: message.text,
            timestamp: new Date().toISOString()
          });

          // Generate and send response if needed
          await this.handleResponse(message);
          
          this.processedTweets.add(message.id);
        }
      }
    } catch (error) {
      elizaLogger.error("❌ Error checking DMs:", error);
    }
  }

  private async handleResponse(interaction: any) {
    try {
      const response = await this.generateResponse(interaction);
      if (!response) return;

      elizaLogger.info('✨ Generated response:', {
        for_id: interaction.id,
        response
      });

      // Send response to webhook
      await this.sendToWebhook('response', {
        type: 'response',
        original_interaction: interaction,
        response: {
          text: response,
          timestamp: new Date().toISOString()
        }
      });

      // Send the actual response
      if (interaction.type === 'dm') {
        await this.client.sendDirectMessage(interaction.sender.id, response);
      } else {
        await this.client.sendTweet(response, interaction.id);
      }

    } catch (error) {
      elizaLogger.error("❌ Error handling response:", error);
    }
  }

  private async generateResponse(interaction: any): Promise<string> {
    try {
      const response = await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: interaction.text || interaction.message,
          userId: interaction.author?.id || interaction.sender?.id,
          userName: interaction.author?.username || interaction.sender?.username,
          roomId: 'twitter'
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate response: ${await response.text()}`);
      }

      const data = await response.json();
      return data[0]?.text || '';
    } catch (error) {
      elizaLogger.error('Error generating response:', error);
      return '';
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
      mention: process.env.WEBHOOK_URL_MENTIONS,
      reply: process.env.WEBHOOK_URL_REPLIES,
      dm: process.env.WEBHOOK_URL_DMS,
      response: process.env.WEBHOOK_URL
    }[type];

    return typeSpecificUrl || process.env.WEBHOOK_URL;
  }
}

class MonitorOnlyTwitterManager {
  interaction: TwitterInteractionHandler;
  client: any;
  private isInitialized: boolean = false;
  private initializationRetries: number = 0;
  private readonly MAX_RETRIES: number = 5;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    elizaLogger.info("🚀 Initializing Twitter monitoring manager...");
    this.runtime = runtime;
    this.initializeTwitterClient(runtime);
  }

  private async initializeTwitterClient(runtime: IAgentRuntime) {
    try {
      elizaLogger.info("🔄 Attempting to initialize Twitter client...");
      
      elizaLogger.info("🔑 Using Twitter credentials:", {
        username: process.env.TWITTER_USERNAME ? "✓ Set" : "✗ Missing",
        email: process.env.TWITTER_EMAIL ? "✓ Set" : "✗ Missing",
        password: process.env.TWITTER_PASSWORD ? "✓ Set" : "✗ Missing"
      });
      
      const twitterClient = await TwitterClientInterface.start(runtime);
      this.client = twitterClient;

      if (this.client.profile) {
        elizaLogger.success("✅ Twitter client initialized successfully with profile:", {
          username: this.client.profile.username,
          id: this.client.profile.id
        });
        
        this.isInitialized = true;
        
        // Initialize and start the interaction handler
        this.interaction = new TwitterInteractionHandler(this.client, runtime);
        await this.interaction.start();
        
      } else {
        throw new Error("Twitter client initialized but profile is missing");
      }
    } catch (error) {
      elizaLogger.error("❌ Failed to initialize Twitter client:", {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        details: error
      });
      
      if (this.initializationRetries < this.MAX_RETRIES) {
        this.initializationRetries++;
        const delay = Math.min(1000 * Math.pow(2, this.initializationRetries), 30000);
        elizaLogger.info(`🔄 Retrying initialization in ${delay/1000} seconds... (Attempt ${this.initializationRetries}/${this.MAX_RETRIES})`);
        
        setTimeout(() => {
          this.initializeTwitterClient(runtime);
        }, delay);
      } else {
        elizaLogger.error("⛔ Max retries reached. Failed to initialize Twitter client.");
      }
    }
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

      // Create Twitter manager through the interface
      const twitterManager = (await TwitterManager.start(runtime)) as typeof TwitterManager & {
        interaction: {
          start(): Promise<void>;
          on(event: string, callback: (data: any) => void): void;
        }
      };
      await twitterManager.interaction.start();

      // Add event listeners
      twitterManager.interaction.on('mention', (mention) => {
        elizaLogger.info('📨 DEBUG: Mention received:', mention);
      });

      twitterManager.interaction.on('dm', (message) => {
        elizaLogger.info('📩 DEBUG: DM received:', message);
      });

      twitterManager.interaction.on('reply', (reply) => {
        elizaLogger.info('↩️ DEBUG: Reply received:', reply);
      });

      clients.push(twitterManager);
      elizaLogger.success("✅ Twitter manager initialized successfully");
    } catch (error) {
      elizaLogger.error("Failed to initialize Twitter client:", error);
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