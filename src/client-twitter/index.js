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
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;
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
    if (!this.client.profile) {
      await this.client.init();
    }

    const generateNewTweetLoop = async () => {
      const lastPost = await this.runtime.cacheManager.get(
        "twitter/" + this.runtime.getSetting("TWITTER_USERNAME") + "/lastPost"
      );
      const lastPostTimestamp = lastPost?.timestamp ?? 0;
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

      elizaLogger.log(`Next post scheduled in ${randomMinutes} minutes`);
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
        homeTimeline.map((tweet) => {
          return `#${tweet.id}\n${tweet.name} (@${tweet.username})${
            tweet.inReplyToStatusId ? `\nIn reply to: ${tweet.inReplyToStatusId}` : ""
          }\n${new Date(tweet.timestamp).toDateString()}\n\n${tweet.text}\n---\n`;
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

      // Instead of posting to Twitter, send to webhook
      const tweetData = {
        id: Date.now().toString(),
        text: content,
        name: this.client.profile.screenName,
        username: this.client.profile.username,
        timestamp: Date.now(),
        permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${Date.now()}`
      };

      // Send to webhook
      await this.webhookHandler.sendToWebhook({
        type: 'post',
        data: tweetData,
        timestamp: Date.now()
      });

      // Cache the tweet data
      await this.runtime.cacheManager.set(
        `twitter/${this.client.profile.username}/lastPost`,
        {
          id: tweetData.id,
          timestamp: tweetData.timestamp
        }
      );

      elizaLogger.log(`Generated post sent to webhook:\n${content}`);

      // Store in memory
      const roomId = stringToUuid(tweetData.id + "-" + this.runtime.agentId);
      await this.runtime.ensureRoomExists(roomId);
      await this.runtime.ensureParticipantInRoom(
        this.runtime.agentId,
        roomId
      );

      await this.runtime.messageManager.createMemory({
        id: stringToUuid(tweetData.id + "-" + this.runtime.agentId),
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: {
          text: content,
          url: tweetData.permanentUrl,
          source: "twitter"
        },
        roomId,
        embedding: embeddingZeroVector,
        createdAt: tweetData.timestamp
      });

    } catch (error) {
      elizaLogger.error("Error generating new tweet:", error);
    }
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
        20,
        SearchMode.Latest
      )).tweets;
      const uniqueTweetCandidates = [...new Set(tweetCandidates)];
      uniqueTweetCandidates.sort((a, b) => a.id.localeCompare(b.id)).filter((tweet) => tweet.userId !== this.client.profile.id);

      for (const tweet of uniqueTweetCandidates) {
        if (!this.client.lastCheckedTweetId || parseInt(tweet.id) > this.client.lastCheckedTweetId) {
          elizaLogger.log("New Tweet found", tweet.permanentUrl);

          // Determine the event type
          let eventType = 'mention';
          if (tweet.referenced_tweets?.some(ref => ref.type === 'replied_to')) {
            eventType = 'reply';
          }

          // Send to webhook immediately when tweet is found
          await this.webhookHandler.sendToWebhook({
            type: eventType,
            data: {
              tweet: {
                id: tweet.id,
                text: tweet.text,
                username: tweet.username,
                name: tweet.name,
                permanentUrl: tweet.permanentUrl,
                timestamp: tweet.timestamp,
                inReplyToStatusId: tweet.inReplyToStatusId
              },
              context: {
                foundAt: new Date().toISOString(),
                searchQuery: `@${twitterUsername}`
              }
            },
            timestamp: Date.now()
          });

          const roomId = stringToUuid3(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userIdUUID = tweet.userId === this.client.profile.id ? this.runtime.agentId : stringToUuid3(tweet.userId);
          await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            tweet.username,
            tweet.name,
            "twitter"
          );

          const thread = await buildConversationThread(
            tweet,
            this.client
          );

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

      // Check for DMs here if needed
      // const dms = await this.client.getDirectMessages();
      // for (const dm of dms) {
      //   await this.webhookHandler.sendToWebhook({
      //     type: 'dm',
      //     data: dm,
      //     timestamp: Date.now()
      //   });
      // }

      await this.client.cacheLatestCheckedTweetId();
      elizaLogger.log("Finished checking Twitter interactions");
    } catch (error) {
      elizaLogger.error("Error handling Twitter interactions:", error);
      
      // Log error to webhook
      await this.webhookHandler.sendToWebhook({
        type: 'error',
        data: {
          error: error.message,
          stack: error.stack,
          context: 'handleTwitterInteractions'
        },
        timestamp: Date.now()
      });
    }
  }
  async handleTweet({
    tweet,
    message,
    thread
  }) {
    try {
      // Create base webhook payload that will be sent in all cases
      const webhookPayload = {
        type: tweet.referenced_tweets?.some(ref => ref.type === 'replied_to') ? 'reply' :
              tweet.text.includes(`@${this.runtime.getSetting("TWITTER_USERNAME")}`) ? 'mention' : 
              'interaction',
        data: {
          incoming_tweet: {
            id: tweet.id,
            text: tweet.text,
            username: tweet.username,
            name: tweet.name,
            permanentUrl: tweet.permanentUrl,
            timestamp: tweet.timestamp,
            inReplyToStatusId: tweet.inReplyToStatusId
          },
          thread: thread.map(t => ({
            id: t.id,
            text: t.text,
            username: t.username,
            timestamp: t.timestamp
          })),
          agent: {
            name: this.runtime.character.name,
            username: this.runtime.getSetting("TWITTER_USERNAME")
          }
        },
        timestamp: Date.now()
      };

      // Process the tweet normally
      const formatTweet = (tweet2) => {
        return `  ID: ${tweet2.id}
  From: ${tweet2.name} (@${tweet2.username})
  Text: ${tweet2.text}`;
      };
      const currentPost = formatTweet(tweet);
      let homeTimeline = [];
      const cachedTimeline = await this.client.getCachedTimeline();
      if (cachedTimeline) {
        homeTimeline = cachedTimeline;
      } else {
        homeTimeline = await this.client.fetchHomeTimeline(50);
        await this.client.cacheTimeline(homeTimeline);
      }

      elizaLogger.debug("Thread: ", thread);
      const formattedConversation = thread.map(
        (tweet2) => `@${tweet2.username} (${new Date(
          tweet2.timestamp * 1e3
        ).toLocaleString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          month: "short",
          day: "numeric"
        })}):
          ${tweet2.text}`
      ).join("\n\n");

      elizaLogger.debug("formattedConversation: ", formattedConversation);
      const formattedHomeTimeline = `# ${this.runtime.character.name}'s Home Timeline\n\n` + 
        homeTimeline.map((tweet2) => {
          return `ID: ${tweet2.id}
From: ${tweet2.name} (@${tweet2.username})${tweet2.inReplyToStatusId ? ` In reply to: ${tweet2.inReplyToStatusId}` : ""}
Text: ${tweet2.text}
---
`;
        }).join("\n");

      let state = await this.runtime.composeState(message, {
        twitterClient: this.client.twitterClient,
        twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
        currentPost,
        formattedConversation,
        timeline: formattedHomeTimeline
      });

      const tweetId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
      const tweetExists = await this.runtime.messageManager.getMemoryById(tweetId);
      if (!tweetExists) {
        elizaLogger.log("tweet does not exist, saving");
        const userIdUUID = stringToUuid3(tweet.userId);
        const roomId = stringToUuid3(tweet.conversationId);
        const message2 = {
          id: tweetId,
          agentId: this.runtime.agentId,
          content: {
            text: tweet.text,
            url: tweet.permanentUrl,
            inReplyTo: tweet.inReplyToStatusId ? stringToUuid3(
              tweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          },
          userId: userIdUUID,
          roomId,
          createdAt: tweet.timestamp * 1e3
        };
        this.client.saveRequestMessage(message2, state);
      }

      const shouldRespondContext = composeContext2({
        state,
        template: this.runtime.character.templates?.twitterShouldRespondTemplate || this.runtime.character?.templates?.shouldRespondTemplate || twitterShouldRespondTemplate
      });
      const shouldRespond = await generateShouldRespond({
        runtime: this.runtime,
        context: shouldRespondContext,
        modelClass: ModelClass2.MEDIUM
      });

      webhookPayload.data.agent_decision = {
        decision: shouldRespond,
        timestamp: Date.now()
      };

      if (shouldRespond !== "RESPOND") {
        elizaLogger.log("Not responding to message");
        // Send webhook with decision not to respond
        await this.webhookHandler.sendToWebhook(webhookPayload);
        return { text: "Response Decision:", action: shouldRespond };
      }

      const context = composeContext2({
        state,
        template: this.runtime.character.templates?.twitterMessageHandlerTemplate || this.runtime.character?.templates?.messageHandlerTemplate || twitterMessageHandlerTemplate
      });
      elizaLogger.debug("Interactions prompt:\n" + context);
      const response = await generateMessageResponse({
        runtime: this.runtime,
        context,
        modelClass: ModelClass2.MEDIUM
      });
      const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
      const stringId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
      response.inReplyTo = stringId;
      response.text = removeQuotes(response.text);

      if (response.text) {
        try {
          const callback = async (response2) => {
            const result = await sendTweet(
              this.client,
              response2,
              message.roomId,
              this.runtime.getSetting("TWITTER_USERNAME"),
              tweet.id,
              this.webhookHandler
            );
            
            // Add response tweets to webhook payload
            webhookPayload.data.agent_response = {
              tweets: result.sentTweets.map((sentTweet, index) => ({
                tweet: sentTweet,
                context: {
                  isThreaded: result.sentTweets.length > 1,
                  partNumber: index + 1,
                  totalParts: result.sentTweets.length,
                  inReplyTo: tweet.id,
                  approvalId: sentTweet.approvalId
                }
              })),
              text: response2.text,
              action: response2.action,
              timestamp: Date.now()
            };

            // Send single webhook with complete interaction data
            await this.webhookHandler.sendToWebhook(webhookPayload);
            
            return result.memories;
          };
          const responseMessages = await callback(response);

          state = await this.runtime.updateRecentMessageState(state);
          for (const responseMessage of responseMessages) {
            if (responseMessage === responseMessages[responseMessages.length - 1]) {
              responseMessage.content.action = response.action;
            } else {
              responseMessage.content.action = "CONTINUE";
            }
            await this.runtime.messageManager.createMemory(responseMessage);
          }

          await this.runtime.evaluate(message, state);
          await this.runtime.processActions(message, responseMessages, state);

          const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
          await this.runtime.cacheManager.set(
            `twitter/tweet_generation_${tweet.id}.txt`,
            responseInfo
          );
          await wait();
        } catch (error) {
          elizaLogger.error(`Error sending response tweet: ${error}`);
          // Send webhook with error information
          webhookPayload.data.error = {
            message: error.message,
            stack: error.stack,
            timestamp: Date.now()
          };
          await this.webhookHandler.sendToWebhook(webhookPayload);
        }
      }
    } catch (error) {
      elizaLogger.error('Error handling tweet:', error);
      // Send webhook with error information
      const errorPayload = {
        type: 'error',
        data: {
          error: error.message,
          stack: error.stack,
          context: 'handleTweet',
          original_tweet: {
            id: tweet.id,
            text: tweet.text,
            username: tweet.username,
            name: tweet.name,
            permanentUrl: tweet.permanentUrl
          }
        },
        timestamp: Date.now()
      };
      await this.webhookHandler.sendToWebhook(errorPayload);
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
        elizaLogger.log(
          "Fetching parent tweet:",
          currentTweet.inReplyToStatusId
        );
        try {
          const parentTweet = await this.twitterClient.getTweet(
            currentTweet.inReplyToStatusId
          );
          if (parentTweet) {
            elizaLogger.log("Found parent tweet:", {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50)
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger.log(
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
      // Get the approval result from webhook handler
      const result = await this.webhookHandler.handleApprovalResponse(approvalId, approved, modifiedContent, reason);
      if (!result) {
        elizaLogger.error('No pending approval found for:', approvalId);
        return;
      }

      // Get the memory associated with this approval
      const memories = await this.runtime.messageManager.getMemoriesByQuery({
        agentId: this.runtime.agentId,
        query: {
          'content.approvalId': approvalId
        }
      });

      if (!memories || memories.length === 0) {
        elizaLogger.error('No memory found for approval:', approvalId);
        return;
      }

      const memory = memories[0];

      if (approved) {
        // Send the approved tweet to Twitter
        const tweetContent = typeof modifiedContent === 'string' ? modifiedContent : modifiedContent?.text || memory.content.text;
        
        try {
          const result = await this.client.twitterClient.sendTweet(
            tweetContent,
            memory.content.inReplyTo
          );

          // Update memory with sent status and Twitter response
          await this.runtime.messageManager.updateMemory({
            ...memory,
            content: {
              ...memory.content,
              status: 'sent',
              twitterResponse: result,
              modifiedText: tweetContent !== memory.content.text ? tweetContent : undefined
            }
          });

          elizaLogger.log('Successfully sent approved tweet:', {
            approvalId,
            tweetId: result.id,
            text: tweetContent
          });
        } catch (error) {
          elizaLogger.error('Error sending approved tweet to Twitter:', error);
          
          // Update memory with error status
          await this.runtime.messageManager.updateMemory({
            ...memory,
            content: {
              ...memory.content,
              status: 'error',
              error: error.message
            }
          });
        }
      } else {
        // Update memory with rejected status
        await this.runtime.messageManager.updateMemory({
          ...memory,
          content: {
            ...memory.content,
            status: 'rejected',
            reason
          }
        });

        elizaLogger.log('Tweet rejected:', {
          approvalId,
          reason
        });
      }
    } catch (error) {
      elizaLogger.error('Error handling approval response:', error);
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

    // Try to login with max retries
    elizaLogger.log("Attempting Twitter login...");
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
          break;
        }
      } catch (error) {
        elizaLogger.error(`Login attempt ${retries + 1} failed:`, error);
        retries++;
        if (retries === maxRetries) {
          throw new Error('Failed to login to Twitter after maximum retries');
        }
        // Wait before next retry
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Load profile after successful login
    this.profile = await this.fetchProfile(username);
    if (!this.profile) {
      throw new Error("Failed to load Twitter profile");
    }

    elizaLogger.log("Twitter user ID:", this.profile.id);
    elizaLogger.log("Twitter loaded:", JSON.stringify(this.profile, null, 2));
    
    this.runtime.character.twitterProfile = {
      id: this.profile.id,
      username: this.profile.username,
      screenName: this.profile.screenName,
      bio: this.profile.bio,
      nicknames: this.profile.nicknames
    };

    await this.loadLatestCheckedTweetId();
    await this.populateTimeline();
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
    elizaLogger4.debug("populating timeline...");
    const cachedTimeline = await this.getCachedTimeline();
    if (cachedTimeline) {
      const existingMemories2 = await this.runtime.messageManager.getMemoriesByRoomIds({
        agentId: this.runtime.agentId,
        roomIds: cachedTimeline.map(
          (tweet) => stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          )
        )
      });
      const existingMemoryIds2 = new Set(
        existingMemories2.map((memory) => memory.id.toString())
      );
      const someCachedTweetsExist = cachedTimeline.some(
        (tweet) => existingMemoryIds2.has(
          stringToUuid4(tweet.id + "-" + this.runtime.agentId)
        )
      );
      if (someCachedTweetsExist) {
        const tweetsToSave2 = cachedTimeline.filter(
          (tweet) => !existingMemoryIds2.has(
            stringToUuid4(tweet.id + "-" + this.runtime.agentId)
          )
        );
        console.log({
          processingTweets: tweetsToSave2.map((tweet) => tweet.id).join(",")
        });
        for (const tweet of tweetsToSave2) {
          elizaLogger4.log("Saving Tweet", tweet.id);
          const roomId = stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid4(tweet.userId);
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
          elizaLogger4.log("Creating memory for tweet", tweet.id);
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid4(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger4.log(
              "Memory already exists, skipping timeline population"
            );
            break;
          }
          await this.runtime.messageManager.createMemory({
            id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: embeddingZeroVector4,
            createdAt: tweet.timestamp * 1e3
          });
          await this.cacheTweet(tweet);
        }
        elizaLogger4.log(
          `Populated ${tweetsToSave2.length} missing tweets from the cache.`
        );
        return;
      }
    }
    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
      20,
      SearchMode2.Latest
    );
    const allTweets = [...timeline, ...mentionsAndInteractions.tweets];
    const tweetIdsToCheck = /* @__PURE__ */ new Set();
    const roomIds = /* @__PURE__ */ new Set();
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(
        stringToUuid4(tweet.conversationId + "-" + this.runtime.agentId)
      );
    }
    const existingMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
      agentId: this.runtime.agentId,
      roomIds: Array.from(roomIds)
    });
    const existingMemoryIds = new Set(
      existingMemories.map((memory) => memory.id)
    );
    const tweetsToSave = allTweets.filter(
      (tweet) => !existingMemoryIds.has(
        stringToUuid4(tweet.id + "-" + this.runtime.agentId)
      )
    );
    elizaLogger4.debug({
      processingTweets: tweetsToSave.map((tweet) => tweet.id).join(",")
    });
    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.profile.username,
      this.runtime.character.name,
      "twitter"
    );
    for (const tweet of tweetsToSave) {
      elizaLogger4.log("Saving Tweet", tweet.id);
      const roomId = stringToUuid4(
        tweet.conversationId + "-" + this.runtime.agentId
      );
      const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid4(tweet.userId);
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
      await this.runtime.messageManager.createMemory({
        id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
        userId,
        content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: embeddingZeroVector4,
        createdAt: tweet.timestamp * 1e3
      });
      await this.cacheTweet(tweet);
    }
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.tweets);
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
    await validateTwitterConfig(runtime);
    elizaLogger5.log("Twitter client started");
    const manager = new TwitterManager(runtime);
    await manager.client.init();
    await manager.post.start();
    await manager.interaction.start();
    return manager;
  },
  async stop(runtime) {
    elizaLogger5.warn("Twitter client does not support stopping yet");
  }
};
var src_default = TwitterClientInterface;
export {
  TwitterClientInterface,
  src_default as default
};
//# sourceMappingURL=index.js.map