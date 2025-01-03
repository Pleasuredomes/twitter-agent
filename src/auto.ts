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
      
      const twitterClient = await TwitterClientInterface.start(runtime) as typeof Client;
      this.client = twitterClient;
      
      if ((twitterClient as any).profile) {
        elizaLogger.success("✅ Twitter client initialized successfully with profile:", {
          username: (twitterClient as any).profile.username,
          id: (twitterClient as any).profile.id
        });
        this.isInitialized = true;
        
        // Set up event listeners for Twitter interactions
        this.setupEventListeners(twitterClient);
        
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

  private setupEventListeners(twitterClient: any) {
    // Listen for tweet discovery
    twitterClient.on('tweet:found', async (data: any) => {
      elizaLogger.info('🔍 New Tweet found:', data.url);
      elizaLogger.info('📦 Tweet data:', {
        id: data.id,
        url: data.url,
        text: data.text
      });
      await this.handleInteraction('tweet_found', {
        id: data.id,
        url: data.url,
        text: data.text,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for tweet processing
    twitterClient.on('tweet:processing', async (data: any) => {
      const tweetId = typeof data === 'string' ? data : data.id;
      elizaLogger.info('⚙️ Processing Tweet:', tweetId);
      elizaLogger.info('📦 Processing data:', { tweetId });
      await this.handleInteraction('tweet_processing', {
        id: tweetId,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for knowledge querying
    twitterClient.on('knowledge:querying', async (data: any) => {
      elizaLogger.info('🧠 Querying knowledge:', data);
      await this.handleInteraction('knowledge_querying', {
        query: data,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for text generation
    twitterClient.on('text:generating', async (data: any) => {
      elizaLogger.info('💭 Generating text');
      await this.handleInteraction('text_generating', {
        timestamp: new Date().toISOString()
      });
    });

    // Listen for message response generation
    twitterClient.on('message:generating', async (data: any) => {
      elizaLogger.info('💬 Generating message response');
      await this.handleInteraction('message_generating', {
        timestamp: new Date().toISOString()
      });
    });

    // Listen for action evaluation
    twitterClient.on('action:evaluating', async (data: any) => {
      elizaLogger.info('⚖️ Evaluating action:', data);
      await this.handleInteraction('action_evaluating', {
        action: data,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for action normalization
    twitterClient.on('action:normalized', async (data: any) => {
      elizaLogger.info('✓ Normalized action:', data);
      await this.handleInteraction('action_normalized', {
        action: data,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for action execution
    twitterClient.on('action:executing', async (data: any) => {
      elizaLogger.info('⚡ Executing action:', data);
      await this.handleInteraction('action_executing', {
        action: data,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for interaction completion
    twitterClient.on('interaction:finished', async () => {
      elizaLogger.info('✅ Finished checking Twitter interactions');
      await this.handleInteraction('interaction_finished', {
        timestamp: new Date().toISOString()
      });
    });

    // Listen for errors
    twitterClient.on('error', (error: any) => {
      elizaLogger.error('❌ Twitter client error:', error);
      this.sendToWebhook({
        event: 'twitter_error',
        data: {
          error: error instanceof Error ? error.message : error,
          timestamp: new Date().toISOString()
        }
      }, process.env.WEBHOOK_URL || '');
    });
  }

  private async startMonitoring() {
    elizaLogger.info("🔄 Starting Twitter monitoring...");
    
    // Wait for client initialization before starting the monitoring interval
    const waitForClient = async () => {
      if (!this.isInitialized || !this.client || !this.client.profile) {
        elizaLogger.warn("⚠️ Twitter client not ready yet, waiting 5 seconds...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        return waitForClient();
      }
      
      // Once client is ready, start the monitoring interval
      const interactionInterval = setInterval(async () => {
        try {
          const twitterUsername = this.client.profile?.username;
          elizaLogger.info(`👀 Checking Twitter interactions for @${twitterUsername}...`);

          // Monitor mentions
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

          // Monitor DMs
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

          // Monitor replies
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
          
          // Send error to webhook
          await this.sendToWebhook({
            event: 'twitter_monitoring_error',
            data: {
              error: error instanceof Error ? error.message : error,
              timestamp: new Date().toISOString()
            }
          }, process.env.WEBHOOK_URL || '');
        }
      }, 30000);

      // Clean up on process exit
      process.on('SIGINT', () => {
        clearInterval(interactionInterval);
        elizaLogger.info("🛑 Stopping Twitter monitoring...");
        process.exit(0);
      });
    };

    // Start the waiting process
    await waitForClient();
  }

  private async handleInteraction(type: string, interaction: any) {
    const interactionId = `${type}-${interaction.id || new Date().getTime()}`;
    
    elizaLogger.info('🎯 Handling interaction:', {
      type,
      id: interactionId
    });
    
    if (this.processedInteractions.has(interactionId)) {
      elizaLogger.info(`🔄 Skipping already processed ${type}`);
      return;
    }

    this.processedInteractions.add(interactionId);

    try {
      // Get webhook URL
      const webhookUrl = this.getWebhookUrl(type);
      if (!webhookUrl) {
        elizaLogger.warn("⚠️ No webhook URL configured");
        return;
      }

      // Prepare the interaction data based on type
      let interactionData: any = {
        type,
        timestamp: new Date().toISOString()
      };

      // Add type-specific data
      switch (type) {
        case 'new_tweet_found':
        case 'processing_tweet':
        case 'generating_response':
        case 'response_generated':
        case 'evaluating_action':
          interactionData = {
            ...interactionData,
            ...interaction
          };
          break;
        default:
          // Handle regular Twitter interactions
          interactionData = {
            ...interactionData,
            id: interaction.id,
            text: interaction.text || interaction.message,
            author: interaction.author?.username || interaction.sender?.username,
            raw_data: interaction
          };
      }

      elizaLogger.info('📤 Preparing webhook payload:', {
        event: `twitter_${type}`,
        data: interactionData
      });

      // Send to webhook
      await this.sendToWebhook({
        event: `twitter_${type}`,
        data: interactionData
      }, webhookUrl);

      // Generate response only for interactive types
      if (['mention', 'dm', 'reply'].includes(type)) {
        elizaLogger.info('🤖 Generating response for interactive type:', type);
        const response = await this.generateResponse(interaction);
        if (response) {
          const responsePayload = {
            event: `twitter_response`,
            data: {
              original_interaction: interactionData,
              response: {
                text: response,
                timestamp: new Date().toISOString()
              }
            }
          };
          elizaLogger.info('📤 Preparing response webhook payload:', responsePayload);
          await this.sendToWebhook(responsePayload, webhookUrl);
        }
      }

    } catch (error) {
      elizaLogger.error(`❌ Error handling ${type}:`, error);
      const errorPayload = {
        event: 'twitter_interaction_error',
        data: {
          type,
          error: error instanceof Error ? error.message : error,
          timestamp: new Date().toISOString()
        }
      };
      elizaLogger.error('📤 Sending error webhook payload:', errorPayload);
      await this.sendToWebhook(errorPayload, process.env.WEBHOOK_URL || '');
    }
  }

  private getWebhookUrl(type: string): string | undefined {
    const typeSpecificUrl = {
      tweet_found: process.env.WEBHOOK_URL_TWEETS,
      tweet_processing: process.env.WEBHOOK_URL_TWEETS,
      knowledge_querying: process.env.WEBHOOK_URL_TWEETS,
      text_generating: process.env.WEBHOOK_URL_TWEETS,
      message_generating: process.env.WEBHOOK_URL_TWEETS,
      action_evaluating: process.env.WEBHOOK_URL_TWEETS,
      action_normalized: process.env.WEBHOOK_URL_TWEETS,
      action_executing: process.env.WEBHOOK_URL_TWEETS,
      interaction_finished: process.env.WEBHOOK_URL_TWEETS,
      error: process.env.WEBHOOK_URL
    }[type];

    return typeSpecificUrl || process.env.WEBHOOK_URL;
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

    elizaLogger.info('📦 Full webhook payload:', JSON.stringify(payload, null, 2));

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
      }

      const responseText = await response.text();
      elizaLogger.info(`📥 Webhook response (${response.status}):`, responseText || "(empty response)");
      elizaLogger.success(`✅ Successfully sent ${payload.event} to webhook`);
    } catch (error) {
      elizaLogger.error("❌ Webhook error:", {
        event: payload.event,
        type: payload.data?.type,
        error: error instanceof Error ? error.message : error,
        payload: JSON.stringify(payload, null, 2)
      });
      throw error;
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