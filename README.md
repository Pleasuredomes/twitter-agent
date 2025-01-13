# Eliza

## Quick Setup Guide

1. **Set Up Google Sheets**:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a new project or select an existing one
   - Enable the Google Sheets API:
     1. Go to "APIs & Services" > "Library"
     2. Search for "Google Sheets API"
     3. Click "Enable"
   - Create service account credentials:
     1. Go to "APIs & Services" > "Credentials"
     2. Click "Create Credentials" > "Service Account"
     3. Fill in service account details and click "Create"
     4. Click on the created service account
     5. Go to "Keys" tab
     6. Click "Add Key" > "Create new key"
     7. Choose JSON format
     8. Download the credentials file
   - Create a new Google Sheet:
     1. Go to [Google Sheets](https://sheets.google.com)
     2. Create a new spreadsheet
     3. Create two sheets named "Approvals"
     4. Share the spreadsheet with the service account email (found in your credentials JSON)
     5. Copy the spreadsheet ID from the URL (the long string between /d/ and /edit)

2. **Configure Your Agent**:
   ```bash
   # 1. Set up .env
   cp .env.example .env
   
   # 2. Add to .env:
   TWITTER_USERNAME="your_username"
   TWITTER_PASSWORD="your_password"
   TWITTER_EMAIL="your_email"
   GOOGLE_SHEETS_SPREADSHEET_ID="your_spreadsheet_id"
   GOOGLE_SHEETS_CREDENTIALS='{"type": "service_account", ...}' # Your entire credentials JSON as a single line

   # Optional: Configure random interactions
   TWITTER_RANDOM_INTERACT_MIN_HOURS=4    # Minimum hours between interaction cycles
   TWITTER_RANDOM_INTERACT_MAX_HOURS=8    # Maximum hours between interaction cycles
   TWITTER_RANDOM_INTERACT_TWEETS_COUNT=5 # Number of tweets to fetch for interaction
   TWITTER_RANDOM_INTERACT_LIKE_CHANCE=0.4   # Probability of liking a tweet
   TWITTER_RANDOM_INTERACT_RETWEET_CHANCE=0.3 # Probability of retweeting
   
   # 3. Create character file (characters/your-character.json):
   {
     "name": "Your Character",
     "clients": ["twitter"]
   }
   
   # 4. Run the agent:
   pnpm auto --character=characters/your-character.json
   ```

## Complete Flow

1. **Agent Generates Tweet**:
   ```
   Agent → Creates tweet → Sends to Google Sheets (status: pending)
   ```

2. **Approval Process**:
   ```
   You review in Google Sheets → Change status to approved/rejected
   ```

3. **Agent Polls for Approvals**:
   ```
   Every 5 minutes:
   Agent → Checks Google Sheets → Processes approved/rejected tweets
   ```

4. **Agent Processes Approvals**:
   ```
   If approved: Agent → Posts to Twitter → Updates status to "sent"
   If rejected: Agent → Logs rejection → Updates status to "rejected"
   ```

5. **Random Interactions**:
   ```
   Every 4-8 hours:
   Agent → Fetches timeline → Randomly selects tweets → Queues interactions for approval
   ```

## Google Sheets Structure

The spreadsheet needs two sheets:

**Approvals Sheet**:
```
- approval_id       # Unique ID for the approval request
- content_type      # Type of content (post, reply, mention, dm, interaction)
- content          # Original content to be approved
- modified_content # Modified content after review (if any)
- context         # Additional context as JSON
- agent_name      # Name of the agent
- agent_username  # Username of the agent
- status         # pending/approved/rejected/sent/error
- timestamp      # When the request was created
- review_timestamp # When the content was reviewed
- reviewer       # Who reviewed the content (optional)
- reason        # Reason for approval/rejection
- tweet_id      # ID of the resulting tweet (if approved and posted)
```

**Interactions Sheet**:
```
- timestamp        # When the interaction occurred
- type            # Type of interaction (like, retweet, reply)
- target_username # Username of the account interacted with
- tweet_id        # ID of the tweet interacted with
- tweet_text      # Content of the tweet
- action          # What action was taken
- response        # Reply content (if applicable)
- status          # success/failed/rejected
- reason          # Reason for rejection/failure
```

## Random Interactions Configuration

The agent can automatically interact with tweets from followed accounts:

1. **Timing Settings**:
   - `TWITTER_RANDOM_INTERACT_MIN_HOURS`: Minimum hours between interaction cycles (default: 4)
   - `TWITTER_RANDOM_INTERACT_MAX_HOURS`: Maximum hours between interaction cycles (default: 8)
   - `TWITTER_RANDOM_INTERACT_MIN_DELAY`: Minimum delay between interactions in seconds (default: 30)
   - `TWITTER_RANDOM_INTERACT_MAX_DELAY`: Maximum delay between interactions in seconds (default: 90)

2. **Interaction Settings**:
   - `TWITTER_RANDOM_INTERACT_TWEETS_COUNT`: Number of tweets to fetch per cycle (default: 5)
   - `TWITTER_RANDOM_INTERACT_LIKE_CHANCE`: Probability of liking a tweet (0-1, default: 0.4)
   - `TWITTER_RANDOM_INTERACT_RETWEET_CHANCE`: Probability of retweeting (0-1, default: 0.3)
   - Remaining probability is used for replies

3. **Approval Process**:
   - All interactions are queued for approval in the Approvals sheet
   - Interactions are logged in the Interactions sheet
   - You can approve/reject each interaction individually

## Troubleshooting

1. **Google Sheets Issues**:
   - Verify service account has edit access to the spreadsheet
   - Check credentials JSON is properly formatted in .env
   - Ensure sheet names match exactly: "Approvals" and "Interactions"
   - Verify spreadsheet ID is correct

2. **Tweet Status Meanings**:
   - pending: Awaiting review
   - sent: Posted to Twitter
   - rejected: Rejected in review
   - error: Failed to post

## Install dependencies and start your agent

```bash
pnpm i && pnpm auto --character=characters/your-character.json
```

## Contributing

Feel free to submit issues and enhancement requests!
