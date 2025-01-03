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
      
      this.client = await TwitterClientInterface.start(runtime);
      
      if (this.client?.profile) {
        elizaLogger.success("✅ Twitter client initialized successfully with profile:", {
          username: this.client.profile.username,
          id: this.client.profile.id
        });
        this.isInitialized = true;
        this.startMonitoring();  // Only start monitoring after client is ready
      } else {
        throw new Error("Twitter client initialized but profile is missing");
      }
    } catch (error) {
      elizaLogger.error("❌ Failed to initialize Twitter client:", error);
      
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
    elizaLogger.info(`🎯 Handling ${type} interaction:`, {
      type,
      from: interaction.author?.username || interaction.sender?.username,
      content: (interaction.text || interaction.message)?.substring(0, 50) + "..."
    });

    try {
      const interactionData = {
        type,
        timestamp: new Date().toISOString(),
        from: interaction.author?.username || interaction.sender?.username,
        content: interaction.text || interaction.message,
        id: interaction.id,
        raw: {
          author: interaction.author,
          sender: interaction.sender,
          text: interaction.text,
          message: interaction.message,
          id: interaction.id,
          created_at: interaction.created_at
        }
      };

      // Send to appropriate webhook based on interaction type
      const webhookUrl = this.getWebhookUrl(type);
      if (webhookUrl) {
        const webhookPayload = {
          event: 'twitter_interaction_received',
          data: interactionData
        };
        
        elizaLogger.info(`📤 Sending ${type} to webhook:`, {
          url: webhookUrl,
          payload: JSON.stringify(webhookPayload, null, 2)
        });
        
        await this.sendToWebhook(webhookPayload, webhookUrl);
      }

      // Generate and send response
      elizaLogger.info("🤖 Generating response...");
      const response = await this.generateResponse(interactionData);
      elizaLogger.info("✍️ Generated response:", response);
      
      let responseResult;
      try {
        elizaLogger.info(`📤 Sending ${type} response...`);
        switch (type) {
          case 'mention':
          case 'reply':
            responseResult = await this.client.reply(interaction.id, response);
            break;
          case 'dm':
            responseResult = await this.client.sendDirectMessage(
              interaction.sender.id, 
              response
            );
            break;
        }
        elizaLogger.success(`✅ Successfully sent ${type} response`);

        // Send response to appropriate webhook
        if (webhookUrl) {
          const responsePayload = {
            event: 'twitter_response_sent',
            data: {
              originalInteraction: interactionData,
              response: {
                content: response,
                timestamp: new Date().toISOString(),
                success: !!responseResult
              }
            }
          };
          
          elizaLogger.info(`📤 Sending response to webhook:`, {
            url: webhookUrl,
            payload: JSON.stringify(responsePayload, null, 2)
          });
          
          await this.sendToWebhook(responsePayload, webhookUrl);
        }
      } catch (error) {
        elizaLogger.error(`❌ Error sending ${type} response:`, error);
        throw error;
      }

    } catch (error) {
      elizaLogger.error(`❌ Error handling ${type}:`, error);
      const webhookUrl = this.getWebhookUrl(type);
      if (webhookUrl) {
        await this.sendToWebhook({
          event: 'twitter_interaction_error',
          data: {
            type,
            error: {
              message: error.message,
              stack: error.stack
            }
          }
        }, webhookUrl);
      }
    }
  }

  private getWebhookUrl(type: 'mention' | 'dm' | 'reply'): string | undefined {
    switch (type) {
      case 'mention':
        return process.env.WEBHOOK_URL_MENTIONS;
      case 'dm':
        return process.env.WEBHOOK_URL_DMS;
      case 'reply':
        return process.env.WEBHOOK_URL_REPLIES;
      default:
        return process.env.WEBHOOK_URL; // fallback to default webhook
    }
  }

  private async sendToWebhook(payload: any, webhookUrl: string) {
    if (!webhookUrl) {
      elizaLogger.warn("⚠️ Webhook URL not configured for this interaction type");
      return;
    }

    elizaLogger.info(`🌐 Attempting to send to webhook (${payload.event}):`, webhookUrl);
    elizaLogger.info("📦 Payload being sent:", JSON.stringify(payload, null, 2));

    try {
      elizaLogger.info("🚀 Sending webhook request...");
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      elizaLogger.info("📥 Webhook response status:", response.status, response.statusText);
      
      const responseText = await response.text();
      elizaLogger.info("📄 Webhook response body:", responseText || "(empty response)");

      if (!response.ok) {
        elizaLogger.error("❌ Webhook request failed:", {
          status: response.status,
          statusText: response.statusText,
          response: responseText
        });
        throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
      }

      elizaLogger.success(`✅ Successfully sent ${payload.event} to webhook`);
      elizaLogger.info("⏱️ Webhook round-trip completed at:", new Date().toISOString());

    } catch (error) {
      elizaLogger.error("❌ Error sending to webhook:", {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      elizaLogger.error("📦 Failed payload:", {
        event: payload.event,
        dataSnapshot: JSON.stringify(payload.data, null, 2)
      });
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

    // Send to webhook if configured
    if (process.env.WEBHOOK_URL) {
      const webhookUrl = process.env.WEBHOOK_URL;
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
      elizaLogger.warn("⚠️ Webhook URL not configured");
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