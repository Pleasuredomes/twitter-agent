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
import TwitterManager from "./client-twitter";
import { TwitterClientInterface } from "./client-twitter";
import Client from "./client-twitter";

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

class MonitorOnlyTwitterManager {
  interaction: TwitterInteraction;
  client: any;
  private isInitialized: boolean = false;
  private initializationRetries: number = 0;
  private readonly MAX_RETRIES: number = 5;
  private runtime: IAgentRuntime;
  private processedInteractions: Set<string> = new Set(); // Track processed interactions

  constructor(runtime: IAgentRuntime) {
    elizaLogger.info("🚀 Initializing Twitter monitoring manager...");
    this.runtime = runtime;
    this.initializeTwitterClient(runtime);
  }

  private async initializeTwitterClient(runtime: IAgentRuntime) {
    try {
      elizaLogger.info("🔄 Attempting to initialize Twitter client...");
      
      // Log credentials being used (safely)
      elizaLogger.info("🔑 Using Twitter credentials:", {
        username: process.env.TWITTER_USERNAME ? "✓ Set" : "✗ Missing",
        email: process.env.TWITTER_EMAIL ? "✓ Set" : "✗ Missing",
        password: process.env.TWITTER_PASSWORD ? "✓ Set" : "✗ Missing"
      });
      
      this.client = await TwitterClientInterface.start(runtime);
      
      if (this.client?.profile) {
        elizaLogger.success("✅ Twitter client initialized successfully with profile:", {
          username: this.client.profile.username,
          id: this.client.profile.id
        });
        this.isInitialized = true;
        this.startMonitoring();
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

  private async startMonitoring() {
    elizaLogger.info("🔄 Starting Twitter monitoring...");
    
    // Separate interval for interaction monitoring (every 30 seconds)
    const interactionInterval = setInterval(async () => {
      if (!this.client || !this.client.profile) {
        elizaLogger.error("⚠️ Twitter client not ready yet");
        return;
      }

      const twitterUsername = this.client.profile?.username;
      elizaLogger.info(`👀 Checking Twitter interactions for @${twitterUsername}...`);

      try {
        // Monitor mentions (every 30 seconds)
        if (this.client.fetchSearchTweets) {
          elizaLogger.info("🔍 Checking mentions...");
          const mentions = await this.client.fetchSearchTweets(`@${twitterUsername}`, 20);
          elizaLogger.info(`📨 Found ${mentions?.length || 0} mentions`);
          if (mentions?.length > 0) {
            for (const mention of mentions) {
              await this.handleInteraction('mention', mention);
            }
          }
        }

        // Monitor DMs (every 30 seconds)
        if (this.client.fetchDirectMessages) {
          elizaLogger.info("🔍 Checking DMs...");
          const messages = await this.client.fetchDirectMessages();
          elizaLogger.info(`📨 Found ${messages?.length || 0} DMs`);
          if (messages?.length > 0) {
            for (const message of messages) {
              await this.handleInteraction('dm', message);
            }
          }
        }

        // Monitor replies (every 30 seconds)
        if (this.client.fetchReplies) {
          elizaLogger.info("🔍 Checking replies...");
          const replies = await this.client.fetchReplies();
          elizaLogger.info(`📨 Found ${replies?.length || 0} replies`);
          if (replies?.length > 0) {
            for (const reply of replies) {
              await this.handleInteraction('reply', reply);
            }
          }
        }

      } catch (error) {
        elizaLogger.error("❌ Error in Twitter monitoring:", error);
        if (error instanceof Error) {
          elizaLogger.error("Error details:", {
            name: error.name,
            message: error.message,
            stack: error.stack
          });
        }
      }
    }, 30000); // Check interactions every 30 seconds

    // Clean up on process exit
    process.on('SIGINT', () => {
      clearInterval(interactionInterval);
      elizaLogger.info("🛑 Stopping Twitter monitoring...");
      process.exit(0);
    });
  }

  private async handleInteraction(type: 'mention' | 'dm' | 'reply', interaction: any) {
    const interactionId = `${type}-${interaction.id}`;
    
    if (this.processedInteractions.has(interactionId)) {
      elizaLogger.info(`🔄 Skipping already processed ${type}`);
      return;
    }

    this.processedInteractions.add(interactionId);

    try {
      // Get webhook URL
      const webhookUrl = process.env.WEBHOOK_URL;
      if (!webhookUrl) {
        elizaLogger.warn("⚠️ No webhook URL configured");
        return;
      }

      // First, send the incoming tweet
      const incomingPayload = {
        event: 'twitter_incoming_tweet',
        data: {
          text: interaction.text || interaction.message,
          author: interaction.author?.username || interaction.sender?.username,
          url: `https://twitter.com/${interaction.author?.username}/status/${interaction.id}`,
          timestamp: new Date().toISOString(),
          type: type,
          tweet_id: interaction.id
        }
      };

      elizaLogger.info("📥 Sending incoming tweet to webhook:", JSON.stringify(incomingPayload, null, 2));
      
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(incomingPayload)
      });

      // Generate response
      const response = await this.generateResponse(interaction);

      if (response) {
        // Send the response to webhook
        const responsePayload = {
          event: 'twitter_outgoing_response',
          data: {
            original_tweet: incomingPayload.data,
            response: {
              text: response,
              timestamp: new Date().toISOString()
            }
          }
        };

        elizaLogger.info("📤 Sending response to webhook:", JSON.stringify(responsePayload, null, 2));
        
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(responsePayload)
        });
      }

    } catch (error) {
      elizaLogger.error(`❌ Error handling ${type}:`, error);
    }
  }

  private getWebhookUrl(type: 'mention' | 'dm' | 'reply'): string | undefined {
    const url = {
      mention: process.env.WEBHOOK_URL_MENTIONS,
      dm: process.env.WEBHOOK_URL_DMS,
      reply: process.env.WEBHOOK_URL_REPLIES
    }[type];

    if (!url) {
      elizaLogger.warn(`⚠️ No webhook URL configured for ${type}, using default webhook`);
      return process.env.WEBHOOK_URL;
    }

    elizaLogger.info(`🎯 Using webhook URL for ${type}: ${url}`);
    return url;
  }

  private async sendToWebhook(payload: any, webhookUrl: string) {
    if (!webhookUrl) {
      elizaLogger.warn("⚠️ No webhook URL provided");
      return;
    }

    elizaLogger.info(`🌐 Sending to webhook:`, {
      url: webhookUrl,
      event: payload.event,
      type: payload.data?.type
    });

    elizaLogger.info("📦 Full payload:", JSON.stringify(payload, null, 2));

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseText = await response.text();
      elizaLogger.info(`📥 Webhook response (${response.status}):`, responseText || "(empty response)");

      if (!response.ok) {
        throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
      }

      elizaLogger.success(`✅ Successfully sent ${payload.event} to webhook`);
    } catch (error) {
      elizaLogger.error("❌ Webhook error:", {
        event: payload.event,
        type: payload.data?.type,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private async generateResponse(interaction: any): Promise<string> {
    // Use the runtime's message generation capability
    try {
      const response = await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: interaction.content,
          userId: interaction.from,
          userName: interaction.from,
          roomId: 'twitter'
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate response: ${await response.text()}`);
      }

      const data = await response.json();
      return data[0]?.text || 'Sorry, I could not generate a response.';
    } catch (error) {
      elizaLogger.error('Error generating response:', error);
      throw error;
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

      const twitterClient = await TwitterClientInterface.start(runtime);
      // Only log safe properties from the Twitter client
      elizaLogger.info("Twitter client initialized with profile:", {
        username: (twitterClient as any)?.profile?.username,
        id: (twitterClient as any)?.profile?.id,
        // Add other safe properties you want to log
      });
      if (twitterClient) {
        clients.push(twitterClient);
        elizaLogger.success("Twitter client initialized successfully");
      }
    } catch (error) {
      elizaLogger.error("Failed to initialize Twitter client. Full error details:", {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        fullError: error,
        errorObject: JSON.stringify(error, null, 2),
        errorProperties: Object.keys(error || {}),
        innerError: error?.innerError ? {
          name: error.innerError.name,
          message: error.innerError.message,
          stack: error.innerError.stack
        } : 'No inner error',
        cause: error?.cause ? {
          name: error.cause.name,
          message: error.cause.message,
          stack: error.cause.stack
        } : 'No cause'
      });

      // Try to parse error message if it's JSON
      try {
        if (typeof error?.message === 'string' && error.message.startsWith('{')) {
          const parsedError = JSON.parse(error.message);
          elizaLogger.error("Parsed error message:", parsedError);
          if (parsedError.errors) {
            elizaLogger.error("Twitter API errors:", parsedError.errors);
          }
        }
      } catch (e) {
        elizaLogger.error("Could not parse error message as JSON");
      }
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