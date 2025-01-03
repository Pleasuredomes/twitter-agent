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

class MonitorOnlyTwitterManager {
  interaction: TwitterInteraction;
  client: any;

  constructor(runtime: IAgentRuntime) {
    elizaLogger.info("Initializing Twitter monitoring manager...");
    
    // Use the static start method and ensure client is initialized
    TwitterClientInterface.start(runtime).then((client: any) => {
      elizaLogger.info("Twitter client initialized with profile:", client.profile);
      this.client = client;
      this.startMonitoring();  // Only start monitoring after client is ready
    }).catch(error => {
      elizaLogger.error("Failed to initialize Twitter client:", error);
    });
  }

  private async startMonitoring() {
    elizaLogger.info("Starting Twitter monitoring...");
    const checkInterval = setInterval(async () => {
      if (!this.client || !this.client.profile) {
        elizaLogger.error("Twitter client not ready yet");
        return;
      }

      const twitterUsername = this.client.profile?.username;
      elizaLogger.info(`Checking Twitter interactions for @${twitterUsername}...`);

      try {
        // Log available methods
        elizaLogger.info("Available client methods:", Object.keys(this.client));
        
        // Monitor mentions
        if (this.client.fetchSearchTweets) {
          elizaLogger.info("Checking mentions...");
          const mentions = await this.client.fetchSearchTweets(`@${twitterUsername}`, 20);
          elizaLogger.info("Raw mentions response:", mentions);
        } else {
          elizaLogger.warn("fetchSearchTweets method not available");
        }

        // Monitor DMs
        if (this.client.fetchDirectMessages) {
          elizaLogger.info("Checking DMs...");
          const messages = await this.client.fetchDirectMessages();
          elizaLogger.info("Raw DMs response:", messages);
        } else {
          elizaLogger.warn("fetchDirectMessages method not available");
        }

        // Monitor replies
        if (this.client.fetchReplies) {
          elizaLogger.info("Checking replies...");
          const replies = await this.client.fetchReplies();
          elizaLogger.info("Raw replies response:", replies);
        } else {
          elizaLogger.warn("fetchReplies method not available");
        }

      } catch (error) {
        elizaLogger.error("Error in Twitter monitoring:", error);
        if (error instanceof Error) {
          elizaLogger.error("Error details:", {
            name: error.name,
            message: error.message,
            stack: error.stack
          });
        }
      }
    }, 60000);

    // Clean up on process exit
    process.on('SIGINT', () => {
      clearInterval(checkInterval);
      elizaLogger.info("Stopping Twitter monitoring...");
      process.exit(0);
    });
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
    
    // Generate a post using the runtime's message generation
    const response = await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/${runtime.character.name}/message`, {
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

    // Send to webhook if configured
    if (runtime.character.settings?.webhook?.enabled) {
      const webhookUrl = runtime.character.settings.webhook.url;
      elizaLogger.info(`🌐 Attempting to send to webhook: ${webhookUrl}`);
      
      const payload = {
        text: post,
        character: runtime.character.name,
        timestamp: new Date().toISOString()
      };
      
      elizaLogger.info("📦 Payload:", JSON.stringify(payload, null, 2));
      
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });
        
        if (response.ok) {
          const responseText = await response.text();
          elizaLogger.success("✅ Successfully sent to webhook");
          elizaLogger.success("📬 Webhook response:", responseText || "(no response body)");
        } else {
          elizaLogger.error("❌ Failed to send to webhook");
          elizaLogger.error("Status:", response.status, response.statusText);
          elizaLogger.error("Response:", await response.text());
        }
      } catch (error) {
        elizaLogger.error("❌ Error sending to webhook:", error);
        if (error instanceof Error) {
          elizaLogger.error("Error details:", {
            name: error.name,
            message: error.message,
            stack: error.stack
          });
        }
      }
    } else {
      elizaLogger.warn("⚠️ Webhook not configured for this character");
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
    
    // Start generating posts at intervals
    const intervalMin = character.settings?.post?.intervalMin || 1;
    const intervalMax = character.settings?.post?.intervalMax || 3;
    
    // Generate first post immediately
    await generateAndSendPost(runtime);
    
    const generatePost = () => {
      const waitTime = (Math.random() * (intervalMax - intervalMin) + intervalMin) * 60000;
      elizaLogger.info(`Next post will be generated in ${Math.round(waitTime/1000)} seconds`);
      
      setTimeout(async () => {
        await generateAndSendPost(runtime);
        generatePost(); // Schedule next post
      }, waitTime);
    };

    // Start the post generation cycle
    generatePost();

    elizaLogger.success("Auto-posting agent started successfully");
    elizaLogger.info(`Will generate posts every ${intervalMin}-${intervalMax} minutes`);

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