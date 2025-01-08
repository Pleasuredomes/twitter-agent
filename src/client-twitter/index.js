// src/post.ts
import {
  composeContext,
  generateText,
  embeddingZeroVector,
  ModelClass,
  stringToUuid
} from "@ai16z/eliza";
import { elizaLogger } from "@ai16z/eliza";
import { WebhookHandler } from './webhook.js';
var twitterPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post from the perspective of {{agentName}}, expressing their personality and views. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.

Your response should be brief and concise. No emojis. Use \\n\\n (double spaces) between statements.`;
var MAX_TWEET_LENGTH = 280;
function truncateToCompleteSentence(text) {
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
var TwitterPostClient = class {
  client;
  runtime;
  webhookHandler;

  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.webhookHandler = new WebhookHandler(
      runtime.character.settings?.webhook?.url,
      runtime.character.settings?.webhook?.logToConsole ?? true,
      runtime
    );
  }

  async start(postImmediately = false) {
    elizaLogger.log("Starting tweet generation service");
    if (!this.client.profile) {
      await this.client.init();
    }

    // Start the post generation loop
    const generateNewTweetLoop = async () => {
      try {
        elizaLogger.log("Running tweet generation cycle");
        const lastPost = await this.runtime.cacheManager.get(
          "twitter/" + this.runtime.getSetting("TWITTER_USERNAME") + "/lastPost"
        );
        const lastPostTimestamp = lastPost?.timestamp ?? 0;
        const minMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
        const maxMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
        const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
        const delay = randomMinutes * 60 * 1000;

        const timeSinceLastPost = Date.now() - lastPostTimestamp;
        const shouldGenerateNow = timeSinceLastPost > delay;
        
        elizaLogger.log(`Last post was ${Math.round(timeSinceLastPost / 60000)} minutes ago`);
        elizaLogger.log(`Should generate now: ${shouldGenerateNow}`);
        
        if (shouldGenerateNow) {
          elizaLogger.log("Generating new tweet...");
          await this.generateNewTweet().catch(err => {
            elizaLogger.error("Error generating tweet:", err);
          });
          elizaLogger.log("Tweet generation complete");
        }

        // Always schedule next check in 5 minutes
        setTimeout(generateNewTweetLoop, 5 * 60 * 1000);
      } catch (error) {
        elizaLogger.error("Error in tweet generation loop:", error);
        // Retry after 5 minutes on error
        setTimeout(generateNewTweetLoop, 5 * 60 * 1000);
      }
    };

    // Start the interaction monitoring loop
    const handleTwitterInteractionsLoop = () => {
      elizaLogger.log("Running interaction check cycle");
      this.handleTwitterInteractions()
        .catch(error => elizaLogger.error("Error in interaction loop:", error))
        .finally(() => {
          // Schedule next check in 2-5 minutes
          setTimeout(
            handleTwitterInteractionsLoop,
            (Math.floor(Math.random() * (5 - 2 + 1)) + 2) * 60 * 1000
          );
        });
    };

    // Generate first tweet immediately if requested
    if (postImmediately) {
      elizaLogger.log("Generating initial tweet...");
      await this.generateNewTweet().catch(err => {
        elizaLogger.error("Error generating initial tweet:", err);
      });
    }

    // Start both loops independently
    generateNewTweetLoop();
    handleTwitterInteractionsLoop();
    
    elizaLogger.log("Tweet generation and interaction monitoring services started");
  }

  async generateNewTweet() {
    try {
      elizaLogger.log("🤖 Starting tweet generation process");
      
      // Log OpenAI configuration
      elizaLogger.log("📝 OpenAI Configuration:", {
        model: this.runtime.getSetting("OPENAI_MODEL") || "default model",
        apiKey: this.runtime.getSetting("OPENAI_API_KEY") ? "Set" : "Not Set"
      });

      // Prepare prompt context
      elizaLogger.log("🎯 Preparing tweet generation prompt");
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid("twitter_generate_room"),
          agentId: this.runtime.agentId,
          content: {
            text: "",
            action: ""
          }
        },
        {
          twitterUserName: this.client.profile.username,
          timeline: ""  // We'll add timeline later if needed
        }
      );

      const context = composeContext({
        state,
        template: this.runtime.character.templates?.twitterPostTemplate || twitterPostTemplate
      });

      elizaLogger.log("✅ Prompt prepared, calling OpenAI...");

      // Make OpenAI call using generateText
      elizaLogger.log("🔄 Making OpenAI API call for tweet generation...");
      const response = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL
      });

      elizaLogger.log("✅ Received OpenAI response:", {
        responseLength: response?.length || 0,
        response: response?.substring(0, 50) + "..." // Log first 50 chars
      });

      if (!response) {
        throw new Error("No response received from OpenAI");
      }

      // Process tweet
      elizaLogger.log("📝 Processing generated tweet...");
      const tweet = truncateToCompleteSentence(response.trim());
      elizaLogger.log("✅ Tweet processed:", {
        length: tweet.length,
        content: tweet
      });

      // Queue for approval
      elizaLogger.log("📤 Queueing tweet for approval...");
      await this.webhookHandler.queueForApproval(tweet, "post");
      elizaLogger.log("✅ Tweet queued for approval successfully");

      // Update last post timestamp in cache
      await this.runtime.cacheManager.set(
        `twitter/${this.runtime.getSetting("TWITTER_USERNAME")}/lastPost`,
        {
          timestamp: Date.now()
        }
      );
      elizaLogger.log("✅ Updated last post timestamp in cache");

      return tweet;
    } catch (error) {
      elizaLogger.error("❌ Error in tweet generation:", {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
      });
      throw error;
    }
  }

  // Helper method to prepare tweet prompt
  async prepareTweetPrompt() {
    elizaLogger.log("🎯 Building tweet prompt context");
    const context = {
      agentName: this.runtime.character.name,
      twitterUserName: this.client.profile.username,
      bio: this.runtime.character.bio,
      style: this.runtime.character.style
    };
    elizaLogger.log("✅ Tweet context prepared:", context);
    return context;
  }

  // Helper method to process tweet response
  processTweetResponse(response) {
    elizaLogger.log("🔍 Processing tweet response");
    // Clean up the response and ensure it meets Twitter requirements
    const cleaned = response.trim().replace(/^["']|["']$/g, '');
    elizaLogger.log("✅ Tweet cleaned and processed");
    return cleaned;
  }
};

// src/interactions.ts
import { SearchMode } from "agent-twitter-client";
import {
  composeContext as composeContext2,
  generateMessageResponse,
  generateShouldRespond,
  messageCompletionFooter,
  shouldRespondFooter,
  ModelClass as ModelClass2,
  stringToUuid as stringToUuid3,
  elizaLogger as elizaLogger3
} from "@ai16z/eliza";

// src/utils.ts
import { embeddingZeroVector as embeddingZeroVector2 } from "@ai16z/eliza";
import { stringToUuid as stringToUuid2 } from "@ai16z/eliza";
import { elizaLogger as elizaLogger2 } from "@ai16z/eliza";
var MAX_TWEET_LENGTH2 = 280;
var wait = (minTime = 1e3, maxTime = 3e3) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};
async function buildConversationThread(tweet, client, maxReplies = 10) {
  const thread = [];
  const visited = /* @__PURE__ */ new Set();
  async function processThread(currentTweet, depth = 0) {
    elizaLogger2.debug("Processing tweet:", {
      id: currentTweet.id,
      inReplyToStatusId: currentTweet.inReplyToStatusId,
      depth
    });
    if (!currentTweet) {
      elizaLogger2.debug("No current tweet found for thread building");
      return;
    }
    if (depth >= maxReplies) {
      elizaLogger2.debug("Reached maximum reply depth", depth);
      return;
    }
    const memory = await client.runtime.messageManager.getMemoryById(
      stringToUuid2(currentTweet.id + "-" + client.runtime.agentId)
    );
    if (!memory) {
      const roomId = stringToUuid2(
        currentTweet.conversationId + "-" + client.runtime.agentId
      );
      const userId = stringToUuid2(currentTweet.userId);
      await client.runtime.ensureConnection(
        userId,
        roomId,
        currentTweet.username,
        currentTweet.name,
        "twitter"
      );
      client.runtime.messageManager.createMemory({
        id: stringToUuid2(
          currentTweet.id + "-" + client.runtime.agentId
        ),
        agentId: client.runtime.agentId,
        content: {
          text: currentTweet.text,
          source: "twitter",
          url: currentTweet.permanentUrl,
          inReplyTo: currentTweet.inReplyToStatusId ? stringToUuid2(
            currentTweet.inReplyToStatusId + "-" + client.runtime.agentId
          ) : void 0
        },
        createdAt: currentTweet.timestamp * 1e3,
        roomId,
        userId: currentTweet.userId === client.profile.id ? client.runtime.agentId : stringToUuid2(currentTweet.userId),
        embedding: embeddingZeroVector2
      });
    }
    if (visited.has(currentTweet.id)) {
      elizaLogger2.debug("Already visited tweet:", currentTweet.id);
      return;
    }
    visited.add(currentTweet.id);
    thread.unshift(currentTweet);
    elizaLogger2.debug("Current thread state:", {
      length: thread.length,
      currentDepth: depth,
      tweetId: currentTweet.id
    });
    if (currentTweet.inReplyToStatusId) {
      elizaLogger2.debug(
        "Fetching parent tweet:",
        currentTweet.inReplyToStatusId
      );
      try {
        const parentTweet = await client.twitterClient.getTweet(
          currentTweet.inReplyToStatusId
        );
        if (parentTweet) {
          elizaLogger2.debug("Found parent tweet:", {
            id: parentTweet.id,
            text: parentTweet.text?.slice(0, 50)
          });
          await processThread(parentTweet, depth + 1);
        } else {
          elizaLogger2.debug(
            "No parent tweet found for:",
            currentTweet.inReplyToStatusId
          );
        }
      } catch (error) {
        elizaLogger2.error("Error fetching parent tweet:", {
          tweetId: currentTweet.inReplyToStatusId,
          error
        });
      }
    } else {
      elizaLogger2.debug(
        "Reached end of reply chain at:",
        currentTweet.id
      );
    }
  }
  await processThread(tweet, 0);
  elizaLogger2.debug("Final thread built:", {
    totalTweets: thread.length,
    tweetIds: thread.map((t) => ({
      id: t.id,
      text: t.text?.slice(0, 50)
    }))
  });
  return thread;
}
async function sendTweet(client, content, roomId, twitterUsername, inReplyTo, webhookHandler) {
  const tweetChunks = splitTweetContent(content.text);
  const pendingTweets = [];
  let previousTweetId = inReplyTo;

  for (const chunk of tweetChunks) {
    // Create tweet data instead of sending to Twitter
    const tweetData = {
      id: Date.now().toString(),
      text: chunk.trim(),
      username: twitterUsername,
      name: client.profile.screenName,
      timestamp: Date.now(),
      inReplyToStatusId: previousTweetId,
      conversationId: roomId,
      permanentUrl: `https://twitter.com/${twitterUsername}/status/${Date.now()}`
    };

    // Queue for approval instead of waiting
    const queueResult = await webhookHandler.queueForApproval(
      tweetData,
      inReplyTo ? 'reply' : 'post',
      {
        isThreaded: tweetChunks.length > 1,
        partNumber: pendingTweets.length + 1,
        totalParts: tweetChunks.length,
        inReplyTo: previousTweetId
      }
    );

    const pendingTweet = {
      ...tweetData,
      approvalId: queueResult.approvalId,
      status: 'pending'
    };

    pendingTweets.push(pendingTweet);
    previousTweetId = pendingTweet.id;
    await wait(1000, 2000);
  }

  const memories = pendingTweets.map((tweet) => ({
    id: stringToUuid2(tweet.id + "-" + client.runtime.agentId),
    agentId: client.runtime.agentId,
    userId: client.runtime.agentId,
    content: {
      text: tweet.text,
      source: "twitter",
      url: tweet.permanentUrl,
      inReplyTo: tweet.inReplyToStatusId ? stringToUuid2(
        tweet.inReplyToStatusId + "-" + client.runtime.agentId
      ) : void 0,
      approvalId: tweet.approvalId,
      status: 'pending_approval'
    },
    roomId,
    embedding: embeddingZeroVector2,
    createdAt: tweet.timestamp
  }));

  return { memories, pendingTweets };
}
function splitTweetContent(content) {
  const maxLength = MAX_TWEET_LENGTH2;
  const paragraphs = content.split("\n\n").map((p) => p.trim());
  const tweets = [];
  let currentTweet = "";
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
      if (currentTweet) {
        currentTweet += "\n\n" + paragraph;
      } else {
        currentTweet = paragraph;
      }
    } else {
      if (currentTweet) {
        tweets.push(currentTweet.trim());
      }
      if (paragraph.length <= maxLength) {
        currentTweet = paragraph;
      } else {
        const chunks = splitParagraph(paragraph, maxLength);
        tweets.push(...chunks.slice(0, -1));
        currentTweet = chunks[chunks.length - 1];
      }
    }
  }
  if (currentTweet) {
    tweets.push(currentTweet.trim());
  }
  return tweets;
}
function splitParagraph(paragraph, maxLength) {
  const sentences = paragraph.match(/[^\.!\?]+[\.!\?]+|[^\.!\?]+$/g) || [
    paragraph
  ];
  const chunks = [];
  let currentChunk = "";
  for (const sentence of sentences) {
    if ((currentChunk + " " + sentence).trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += " " + sentence;
      } else {
        currentChunk = sentence;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        const words = sentence.split(" ");
        currentChunk = "";
        for (const word of words) {
          if ((currentChunk + " " + word).trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += " " + word;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

// src/interactions.ts
import { embeddingZeroVector as embeddingZeroVector3 } from "@ai16z/eliza";
var twitterMessageHandlerTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

# Task: Generate a post for the character {{agentName}}.
About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}


# Task: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:
Current Post:
{{currentPost}}
Thread of Tweets You Are Replying To:

{{formattedConversation}}

{{actions}}

# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). Include an action, if appropriate. {{actionNames}}:
{{currentPost}}
` + messageCompletionFooter;
var twitterShouldRespondTemplate = `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP .

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

{{currentPost}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;
var TwitterInteractionClient = class {
  client;
  runtime;
  webhookHandler;

  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.webhookHandler = new WebhookHandler(
      runtime.character.settings?.webhook?.url,
      runtime.character.settings?.webhook?.logToConsole ?? true,
      runtime
    );
  }

  async start() {
    elizaLogger.log("Starting interaction monitoring...");
    
    // Start monitoring immediately
    await this.handleTwitterInteractions();
    
    const handleTwitterInteractionsLoop = () => {
      elizaLogger.log("Running interaction check cycle");
      this.handleTwitterInteractions()
        .catch(error => elizaLogger.error("Error in interaction loop:", error))
        .finally(() => {
          // Schedule next check in 2-5 minutes
          setTimeout(
            handleTwitterInteractionsLoop,
            (Math.floor(Math.random() * (5 - 2 + 1)) + 2) * 60 * 1000
          );
        });
    };

    // Start the loop
    handleTwitterInteractionsLoop();
    elizaLogger.log("Interaction monitoring started");
  }

  async handleTwitterInteractions() {
    elizaLogger.log("Checking Twitter interactions");
    const twitterUsername = this.client.profile.username;
    try {
      const tweetCandidates = (await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20,
        SearchMode.Latest
      )).tweets;

      if (!tweetCandidates || tweetCandidates.length === 0) {
        elizaLogger.log("No new interactions found");
        return;
      }

      // Process each tweet candidate
      for (const tweet of tweetCandidates) {
        try {
          // Queue for approval
          const result = await this.webhookHandler.queueForApproval(
            {
              user: this.runtime.character.name.toLowerCase(),
              text: "",  // Will be filled by the agent
              action: "NONE"
            },
            "mention",
            {
              tweet_id: tweet.id,
              author_username: tweet.username,
              author_name: tweet.name,
              content: tweet.text,
              found_at: new Date().toISOString(),
              permanent_url: tweet.permanentUrl
            }
          );

          // If queueForApproval returns null, it means this tweet was skipped (duplicate)
          // Just continue to the next tweet
          if (!result) {
            elizaLogger.log("Skipped duplicate tweet, continuing to next one:", tweet.id);
            continue;
          }

          elizaLogger.log("Queued mention for approval:", {
            tweetId: tweet.id,
            approvalId: result.approvalId
          });
        } catch (error) {
          elizaLogger.error("Error processing tweet:", {
            error,
            tweet: {
              id: tweet.id,
              text: tweet.text
            }
          });
          // Continue with next tweet even if this one fails
          continue;
        }
      }
    } catch (error) {
      elizaLogger.error("Error in interaction loop:", error);
    }
  }

  async handleDirectMessage(message) {
    try {
      // Log and send DM to webhook
      await this.webhookHandler.sendToWebhook({
        type: 'dm',
        data: message,
        timestamp: Date.now()
      });

      // Process the DM normally
      // ... existing DM handling code ...
    } catch (error) {
      elizaLogger.error('Error handling direct message:', error);
    }
  }

  async buildConversationThread(tweet, maxReplies = 10) {
    const thread = [];
    const visited = /* @__PURE__ */ new Set();
    async function processThread(currentTweet, depth = 0) {
      elizaLogger.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth
      });
      if (!currentTweet) {
        elizaLogger.log("No current tweet found for thread building");
        return;
      }
      if (depth >= maxReplies) {
        elizaLogger.log("Reached maximum reply depth", depth);
        return;
      }
      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid3(currentTweet.id + "-" + this.runtime.agentId)
      );
      if (!memory) {
        const roomId = stringToUuid3(
          currentTweet.conversationId + "-" + this.runtime.agentId
        );
        const userId = stringToUuid3(currentTweet.userId);
        await this.runtime.ensureConnection(
          userId,
          roomId,
          currentTweet.username,
          currentTweet.name,
          "twitter"
        );
        this.runtime.messageManager.createMemory({
          id: stringToUuid3(
            currentTweet.id + "-" + this.runtime.agentId
          ),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text,
            source: "twitter",
            url: currentTweet.permanentUrl,
            inReplyTo: currentTweet.inReplyToStatusId ? stringToUuid3(
              currentTweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          },
          createdAt: currentTweet.timestamp * 1e3,
          roomId,
          userId: currentTweet.userId === this.twitterUserId ? this.runtime.agentId : stringToUuid3(currentTweet.userId),
          embedding: embeddingZeroVector3
        });
      }
      if (visited.has(currentTweet.id)) {
        elizaLogger.log("Already visited tweet:", currentTweet.id);
        return;
      }
      visited.add(currentTweet.id);
      thread.unshift(currentTweet);
      elizaLogger.debug("Current thread state:", {
        length: thread.length,
        currentDepth: depth,
        tweetId: currentTweet.id
      });
      if (currentTweet.inReplyToStatusId) {
        elizaLogger.debug(
          "Fetching parent tweet:",
          currentTweet.inReplyToStatusId
        );
        try {
          const parentTweet = await this.twitterClient.getTweet(
            currentTweet.inReplyToStatusId
          );
          if (parentTweet) {
            elizaLogger.debug("Found parent tweet:", {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50)
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger.debug(
              "No parent tweet found for:",
              currentTweet.inReplyToStatusId
            );
          }
        } catch (error) {
          elizaLogger.log("Error fetching parent tweet:", {
            tweetId: currentTweet.inReplyToStatusId,
            error
          });
        }
      } else {
        elizaLogger.log(
          "Reached end of reply chain at:",
          currentTweet.id
        );
      }
    }
    await processThread.bind(this)(tweet, 0);
    elizaLogger.debug("Final thread built:", {
      totalTweets: thread.length,
      tweetIds: thread.map((t) => ({
        id: t.id,
        text: t.text?.slice(0, 50)
      }))
    });
    return thread;
  }

  // Add method to handle approval responses
  async handleApprovalResponse(approvalId, approved, modifiedContent = null, reason = '') {
    try {
      elizaLogger.log("🔄 Processing approval response:", {
        approvalId,
        approved,
        hasModifiedContent: !!modifiedContent,
        reason
      });

      // Get the memory associated with this approval
      elizaLogger.log("🔍 Looking up memory for approval...");
      const memories = await this.runtime.messageManager.getMemoriesByQuery({
        agentId: this.runtime.agentId,
        query: {
          'content.approvalId': approvalId
        }
      });

      if (!memories || memories.length === 0) {
        elizaLogger.error('❌ No memory found for approval:', approvalId);
        return;
      }

      const memory = memories[0];
      elizaLogger.log("✅ Found memory:", {
        id: memory.id,
        content: memory.content,
        roomId: memory.roomId
      });

      if (approved) {
        // Send the approved tweet to Twitter
        const tweetContent = typeof modifiedContent === 'string' ? modifiedContent : modifiedContent?.text || memory.content.text;
        
        elizaLogger.log("📝 Preparing to post tweet:", {
          content: tweetContent,
          inReplyTo: memory.content.inReplyTo
        });

        try {
          elizaLogger.log("🔄 Making Twitter API call...");
          const result = await this.client.twitterClient.sendTweet(
            tweetContent,
            memory.content.inReplyTo
          );
          elizaLogger.log("✅ Twitter API response:", result);

          // Update memory with sent status and Twitter response
          elizaLogger.log("💾 Updating memory with success status...");
          await this.runtime.messageManager.updateMemory({
            ...memory,
            content: {
              ...memory.content,
              status: 'sent',
              twitterResponse: result,
              modifiedText: tweetContent !== memory.content.text ? tweetContent : undefined
            }
          });

          elizaLogger.log('✅ Successfully sent approved tweet:', {
            approvalId,
            tweetId: result.id,
            text: tweetContent
          });
        } catch (error) {
          elizaLogger.error('❌ Error sending tweet to Twitter:', {
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack,
              code: error.code,
              response: error.response?.data,
              status: error.response?.status
            },
            tweet: {
              content: tweetContent,
              length: tweetContent.length,
              inReplyTo: memory.content.inReplyTo
            }
          });
          
          // Update memory with error status
          elizaLogger.log("💾 Updating memory with error status...");
          await this.runtime.messageManager.updateMemory({
            ...memory,
            content: {
              ...memory.content,
              status: 'error',
              error: {
                message: error.message,
                code: error.code,
                response: error.response?.data
              }
            }
          });
        }
      } else {
        // Update memory with rejected status
        elizaLogger.log("💾 Updating memory with rejected status...");
        await this.runtime.messageManager.updateMemory({
          ...memory,
          content: {
            ...memory.content,
            status: 'rejected',
            reason
          }
        });

        elizaLogger.log('ℹ️ Tweet rejected:', {
          approvalId,
          reason
        });
      }
    } catch (error) {
      elizaLogger.error('❌ Error in approval response handler:', {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        },
        context: {
          approvalId,
          approved,
          hasModifiedContent: !!modifiedContent
        }
      });
      throw error;
    }
  }
};

// src/index.ts
import { elizaLogger as elizaLogger5 } from "@ai16z/eliza";

// src/enviroment.ts
import { z } from "zod";
var twitterEnvSchema = z.object({
  TWITTER_DRY_RUN: z.string().transform((val) => val.toLowerCase() === "true"),
  TWITTER_USERNAME: z.string().min(1, "Twitter username is required"),
  TWITTER_PASSWORD: z.string().min(1, "Twitter password is required"),
  TWITTER_EMAIL: z.string().email("Valid Twitter email is required"),
  TWITTER_COOKIES: z.string().optional()
});
async function validateTwitterConfig(runtime) {
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
        `Twitter configuration validation failed:
${errorMessages}`
      );
    }
    throw error;
  }
}

// src/base.ts
import {
  embeddingZeroVector as embeddingZeroVector4,
  elizaLogger as elizaLogger4,
  stringToUuid as stringToUuid4
} from "@ai16z/eliza";
import {
  Scraper,
  SearchMode as SearchMode2
} from "agent-twitter-client";
import { EventEmitter } from "events";
var RequestQueue = class {
  queue = [];
  processing = false;
  async add(request) {
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
  async processQueue() {
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
  async exponentialBackoff(retryCount) {
    const delay = Math.pow(2, retryCount) * 1e3;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  async randomDelay() {
    const delay = Math.floor(Math.random() * 2e3) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
var ClientBase = class _ClientBase extends EventEmitter {
  static _twitterClient;
  twitterClient;
  runtime;
  directions;
  lastCheckedTweetId = null;
  imageDescriptionService;
  temperature = 0.5;
  requestQueue = new RequestQueue();
  profile;
  async cacheTweet(tweet) {
    if (!tweet) {
      console.warn("Tweet is undefined, skipping cache");
      return;
    }
    this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
  }
  async getCachedTweet(tweetId) {
    const cached = await this.runtime.cacheManager.get(
      `twitter/tweets/${tweetId}`
    );
    return cached;
  }
  async getTweet(tweetId) {
    const cachedTweet = await this.getCachedTweet(tweetId);
    if (cachedTweet) {
      return cachedTweet;
    }
    const tweet = await this.requestQueue.add(
      () => this.twitterClient.getTweet(tweetId)
    );
    await this.cacheTweet(tweet);
    return tweet;
  }
  callback = null;
  onReady() {
    throw new Error(
      "Not implemented in base class, please call from subclass"
    );
  }
  constructor(runtime) {
    super();
    this.runtime = runtime;
    if (_ClientBase._twitterClient) {
      this.twitterClient = _ClientBase._twitterClient;
    } else {
      this.twitterClient = new Scraper();
      _ClientBase._twitterClient = this.twitterClient;
    }
    this.directions = "- " + this.runtime.character.style.all.join("\n- ") + "- " + this.runtime.character.style.post.join();
  }
  async init() {
    const username = this.runtime.getSetting("TWITTER_USERNAME");
    if (!username) {
      throw new Error("Twitter username not configured");
    }

    // Try to use cached cookies first
    elizaLogger.log("🔄 Checking for cached cookies...");
    if (this.runtime.getSetting("TWITTER_COOKIES")) {
      const cookiesArray = JSON.parse(
        this.runtime.getSetting("TWITTER_COOKIES")
      );
      await this.setCookiesFromArray(cookiesArray);
      elizaLogger.log("✅ Using provided cookies");
    } else {
      const cachedCookies = await this.getCachedCookies(username);
      if (cachedCookies) {
        await this.setCookiesFromArray(cachedCookies);
        elizaLogger.log("✅ Using cached cookies");
      }
    }

    // Try to login with max retries
    elizaLogger.log("🔄 Attempting Twitter login...");
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
      try {
        await this.twitterClient.login(
          username,
          this.runtime.getSetting("TWITTER_PASSWORD"),
          this.runtime.getSetting("TWITTER_EMAIL"),
          this.runtime.getSetting("TWITTER_2FA_SECRET")
        );
        
        if (await this.twitterClient.isLoggedIn()) {
          const cookies = await this.twitterClient.getCookies();
          await this.cacheCookies(username, cookies);
          elizaLogger.log("✅ Twitter login successful");
          break;
        }
      } catch (error) {
        elizaLogger.error(`❌ Login attempt ${retries + 1} failed:`, error);
        retries++;
        if (retries === maxRetries) {
          throw new Error('Failed to login to Twitter after maximum retries');
        }
        // Wait before next retry
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Load profile after successful login
    elizaLogger.log("🔄 Loading Twitter profile...");
    this.profile = await this.fetchProfile(username);
    if (!this.profile) {
      throw new Error("Failed to load Twitter profile");
    }

    elizaLogger.log("✅ Twitter profile loaded:", {
      id: this.profile.id,
      username: this.profile.username,
      screenName: this.profile.screenName
    });
    
    this.runtime.character.twitterProfile = {
      id: this.profile.id,
      username: this.profile.username,
      screenName: this.profile.screenName,
      bio: this.profile.bio,
      nicknames: this.profile.nicknames
    };

    elizaLogger.log("🔄 Loading last checked tweet ID...");
    await this.loadLatestCheckedTweetId();
    elizaLogger.log("✅ Last checked tweet ID loaded:", this.lastCheckedTweetId || "No previous tweets");

    elizaLogger.log("🔄 Populating timeline...");
    await this.populateTimeline();
    elizaLogger.log("✅ Timeline populated");

    elizaLogger.log("✅ Twitter client initialization complete");
  }
  async fetchHomeTimeline(count) {
    elizaLogger4.debug("fetching home timeline");
    const homeTimeline = await this.twitterClient.getUserTweets(
      this.profile.id,
      count
    );
    return homeTimeline.tweets;
  }
  async fetchSearchTweets(query, maxTweets, searchMode, cursor) {
    try {
      const timeoutPromise = new Promise(
        (resolve) => setTimeout(() => resolve({ tweets: [] }), 1e4)
      );
      try {
        const result = await this.requestQueue.add(
          async () => await Promise.race([
            this.twitterClient.fetchSearchTweets(
              query,
              maxTweets,
              searchMode,
              cursor
            ),
            timeoutPromise
          ])
        );
        return result ?? { tweets: [] };
      } catch (error) {
        elizaLogger4.error("Error fetching search tweets:", error);
        return { tweets: [] };
      }
    } catch (error) {
      elizaLogger4.error("Error fetching search tweets:", error);
      return { tweets: [] };
    }
  }
  async populateTimeline() {
    elizaLogger4.log("🔄 Starting timeline population...");
    
    // Check cache first
    elizaLogger4.log("📂 Checking for cached timeline...");
    const cachedTimeline = await this.getCachedTimeline();
    if (cachedTimeline) {
      elizaLogger4.log("✅ Found cached timeline with", cachedTimeline.length, "tweets");
      
      const existingMemories2 = await this.runtime.messageManager.getMemoriesByRoomIds({
        agentId: this.runtime.agentId,
        roomIds: cachedTimeline.map(
          (tweet) => stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          )
        )
      });
      elizaLogger4.log("📊 Found", existingMemories2.length, "existing memories");
      
      const existingMemoryIds2 = new Set(
        existingMemories2.map((memory) => memory.id.toString())
      );
      const someCachedTweetsExist = cachedTimeline.some(
        (tweet) => existingMemoryIds2.has(
          stringToUuid4(tweet.id + "-" + this.runtime.agentId)
        )
      );
      
      if (someCachedTweetsExist) {
        elizaLogger4.log("🔄 Processing cached tweets...");
        const tweetsToSave2 = cachedTimeline.filter(
          (tweet) => !existingMemoryIds2.has(
            stringToUuid4(tweet.id + "-" + this.runtime.agentId)
          )
        );
        elizaLogger4.log("📝 Need to save", tweetsToSave2.length, "new tweets from cache");
        
        for (const tweet of tweetsToSave2) {
          elizaLogger4.log("💾 Saving tweet", tweet.id);
          const roomId = stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid4(tweet.userId);
          
          elizaLogger4.log("👤 Ensuring user connections...");
          if (tweet.userId === this.profile.id) {
            await this.runtime.ensureConnection(
              this.runtime.agentId,
              roomId,
              this.profile.username,
              this.profile.screenName,
              "twitter"
            );
          } else {
            await this.runtime.ensureConnection(
              userId,
              roomId,
              tweet.username,
              tweet.name,
              "twitter"
            );
          }
          
          const content = {
            text: tweet.text,
            url: tweet.permanentUrl,
            source: "twitter",
            inReplyTo: tweet.inReplyToStatusId ? stringToUuid4(
              tweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          };
          
          elizaLogger4.log("🔍 Checking for existing memory...");
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid4(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger4.log("⚠️ Memory already exists, skipping");
            break;
          }
          
          elizaLogger4.log("📝 Creating new memory...");
          await this.runtime.messageManager.createMemory({
            id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: embeddingZeroVector4,
            createdAt: tweet.timestamp * 1e3
          });
          
          elizaLogger4.log("💾 Caching tweet...");
          await this.cacheTweet(tweet);
        }
        elizaLogger4.log("✅ Populated", tweetsToSave2.length, "tweets from cache");
        return;
      }
    }

    elizaLogger4.log("🔄 Fetching fresh timeline...");
    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
    elizaLogger4.log("✅ Fetched", timeline.length, "timeline tweets");

    elizaLogger4.log("🔄 Fetching mentions and interactions...");
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
      20,
      SearchMode2.Latest
    );
    elizaLogger4.log("✅ Fetched", mentionsAndInteractions.tweets.length, "mentions");

    const allTweets = [...timeline, ...mentionsAndInteractions.tweets];
    elizaLogger4.log("📊 Total tweets to process:", allTweets.length);

    elizaLogger4.log("🔄 Processing tweets...");
    const tweetIdsToCheck = new Set();
    const roomIds = new Set();
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(
        stringToUuid4(tweet.conversationId + "-" + this.runtime.agentId)
      );
    }

    elizaLogger4.log("🔍 Checking for existing memories...");
    const existingMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
      agentId: this.runtime.agentId,
      roomIds: Array.from(roomIds)
    });
    elizaLogger4.log("📊 Found", existingMemories.length, "existing memories");

    const existingMemoryIds = new Set(
      existingMemories.map((memory) => memory.id)
    );
    const tweetsToSave = allTweets.filter(
      (tweet) => !existingMemoryIds.has(
        stringToUuid4(tweet.id + "-" + this.runtime.agentId)
      )
    );
    elizaLogger4.log("📝 Need to save", tweetsToSave.length, "new tweets");

    elizaLogger4.log("👤 Ensuring user exists...");
    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.profile.username,
      this.runtime.character.name,
      "twitter"
    );

    elizaLogger4.log("🔄 Saving new tweets...");
    for (const tweet of tweetsToSave) {
      elizaLogger4.log("💾 Processing tweet", tweet.id);
      const roomId = stringToUuid4(
        tweet.conversationId + "-" + this.runtime.agentId
      );
      const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid4(tweet.userId);
      
      elizaLogger4.log("👤 Ensuring connections...");
      if (tweet.userId === this.profile.id) {
        await this.runtime.ensureConnection(
          this.runtime.agentId,
          roomId,
          this.profile.username,
          this.profile.screenName,
          "twitter"
        );
      } else {
        await this.runtime.ensureConnection(
          userId,
          roomId,
          tweet.username,
          tweet.name,
          "twitter"
        );
      }

      const content = {
        text: tweet.text,
        url: tweet.permanentUrl,
        source: "twitter",
        inReplyTo: tweet.inReplyToStatusId ? stringToUuid4(tweet.inReplyToStatusId) : void 0
      };

      elizaLogger4.log("📝 Creating memory...");
      await this.runtime.messageManager.createMemory({
        id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
        userId,
        content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: embeddingZeroVector4,
        createdAt: tweet.timestamp * 1e3
      });

      elizaLogger4.log("💾 Caching tweet...");
      await this.cacheTweet(tweet);
    }

    elizaLogger4.log("💾 Updating cache...");
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.tweets);

    elizaLogger4.log("✅ Timeline population complete");
  }
  async setCookiesFromArray(cookiesArray) {
    const cookieStrings = cookiesArray.map(
      (cookie) => `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${cookie.secure ? "Secure" : ""}; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${cookie.sameSite || "Lax"}`
    );
    await this.twitterClient.setCookies(cookieStrings);
  }
  async saveRequestMessage(message, state) {
    if (message.content.text) {
      const recentMessage = await this.runtime.messageManager.getMemories(
        {
          roomId: message.roomId,
          agentId: this.runtime.agentId,
          count: 1,
          unique: false
        }
      );
      if (recentMessage.length > 0 && recentMessage[0].content === message.content) {
        elizaLogger4.debug("Message already saved", recentMessage[0].id);
      } else {
        await this.runtime.messageManager.createMemory({
          ...message,
          embedding: embeddingZeroVector4
        });
      }
      await this.runtime.evaluate(message, {
        ...state,
        twitterClient: this.twitterClient
      });
    }
  }
  async loadLatestCheckedTweetId() {
    const latestCheckedTweetId = await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/latest_checked_tweet_id`
    );
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
  async getCachedTimeline() {
    return await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/timeline`
    );
  }
  async cacheTimeline(timeline) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/timeline`,
      timeline,
      { expires: 10 * 1e3 }
    );
  }
  async cacheMentions(mentions) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/mentions`,
      mentions,
      { expires: 10 * 1e3 }
    );
  }
  async getCachedCookies(username) {
    return await this.runtime.cacheManager.get(
      `twitter/${username}/cookies`
    );
  }
  async cacheCookies(username, cookies) {
    await this.runtime.cacheManager.set(
      `twitter/${username}/cookies`,
      cookies
    );
  }
  async getCachedProfile(username) {
    return await this.runtime.cacheManager.get(
      `twitter/${username}/profile`
    );
  }
  async cacheProfile(profile) {
    await this.runtime.cacheManager.set(
      `twitter/${profile.username}/profile`,
      profile
    );
  }
  async fetchProfile(username) {
    const cached = await this.getCachedProfile(username);
    if (cached) return cached;
    try {
      const profile = await this.requestQueue.add(async () => {
        const profile2 = await this.twitterClient.getProfile(username);
        return {
          id: profile2.userId,
          username,
          screenName: profile2.name || this.runtime.character.name,
          bio: profile2.biography || typeof this.runtime.character.bio === "string" ? this.runtime.character.bio : this.runtime.character.bio.length > 0 ? this.runtime.character.bio[0] : "",
          nicknames: this.runtime.character.twitterProfile?.nicknames || []
        };
      });
      this.cacheProfile(profile);
      return profile;
    } catch (error) {
      console.error("Error fetching Twitter profile:", error);
      return void 0;
    }
  }
};

// src/index.ts
var TwitterManager = class {
  client;
  post;
  search;
  interaction;

  constructor(runtime) {
    this.client = new ClientBase(runtime);
    this.post = new TwitterPostClient(this.client, runtime);
    this.interaction = new TwitterInteractionClient(this.client, runtime);
  }

  // Add method to handle incoming approval responses from Airtable
  async handleAirtableApproval(payload) {
    try {
      if (payload.type !== 'approval_response' || !payload.data?.approval_id) {
        elizaLogger.error('Invalid approval payload:', payload);
        return;
      }

      const { approval_id, approved, modified_content, reason } = payload.data;
      
      // Forward the approval to the interaction client
      await this.interaction.handleApprovalResponse(
        approval_id,
        approved === true || approved === 'true',
        modified_content,
        reason
      );

      return {
        success: true,
        message: `Successfully processed ${approved ? 'approval' : 'rejection'} for ID: ${approval_id}`
      };

    } catch (error) {
      elizaLogger.error('Error handling Airtable approval:', error);
      throw error;
    }
  }
};
var TwitterClientInterface = {
  async start(runtime) {
    try {
      // Step 1: Validate configuration and setup
      elizaLogger5.log("🚀 Starting Twitter client initialization...");
      await validateTwitterConfig(runtime);
      elizaLogger5.log("✅ Twitter configuration validated");

      // Step 2: Create manager and initialize components
      const manager = new TwitterManager(runtime);
      elizaLogger5.log("✅ Twitter manager created");

      // Step 3: Initialize base client (handles Twitter connection)
      elizaLogger5.log("🔄 Initializing Twitter client...");
      await manager.client.init();
      elizaLogger5.log("✅ Twitter client initialized and logged in");

      // Step 4: Initialize webhook handler
      elizaLogger5.log("🔄 Initializing Google Sheets connection...");
      await manager.post.webhookHandler.initGoogleSheets();
      elizaLogger5.log("✅ Google Sheets connection initialized");

      // Step 5: Start interaction monitoring
      elizaLogger5.log("🔄 Starting interaction monitoring service...");
      await manager.interaction.start();
      elizaLogger5.log("✅ Interaction monitoring service started");

      // Step 6: Start post generation with immediate first post
      elizaLogger5.log("🔄 Starting tweet generation service...");
      await manager.post.start(true); // true = generate first tweet immediately
      elizaLogger5.log("✅ Tweet generation service started");

      // Step 7: Start periodic cleanup
      elizaLogger5.log("⏰ Setting up periodic tasks...");
      const cleanupInterval = 30 * 60 * 1000; // 30 minutes
      setInterval(() => {
        elizaLogger5.log("🧹 Running periodic cleanup...");
        manager.post.webhookHandler.cleanup()
          .catch(err => elizaLogger5.error("❌ Error in cleanup:", err));
      }, cleanupInterval);
      elizaLogger5.log("✅ Periodic cleanup scheduled");

      // Step 8: Set up status checking interval for approvals
      const checkInterval = 5 * 60 * 1000; // 5 minutes
      setInterval(() => {
        elizaLogger5.log("🔍 Checking pending approvals...");
        manager.post.webhookHandler.checkPendingApprovals()
          .catch(err => elizaLogger5.error("❌ Error checking approvals:", err));
      }, checkInterval);
      elizaLogger5.log("✅ Approval checking scheduled");

      // Step 9: Start immediate approval check
      elizaLogger5.log("🔄 Running initial approval check...");
      await manager.post.webhookHandler.checkPendingApprovals()
        .catch(err => elizaLogger5.error("❌ Error in initial approval check:", err));
      elizaLogger5.log("✅ Initial approval check completed");

      elizaLogger5.log("✨ Twitter client fully initialized and running");
      return manager;

    } catch (error) {
      elizaLogger5.error("❌ Failed to start Twitter client:", error);
      throw error;
    }
  },

  async stop(runtime) {
    elizaLogger5.warn("Stopping Twitter client...");
    // Add cleanup code here if needed
  }
};
var src_default = TwitterClientInterface;
export {
  TwitterClientInterface,
  src_default as default
};
//# sourceMappingURL=index.js.map