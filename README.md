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
     3. Create a sheet named "Approvals"
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

## Google Sheets Structure

The spreadsheet needs one sheet:

**Approvals Sheet**:
```
- approval_id       # Unique ID for the approval request
- content_type      # Type of content (post, reply, mention, dm)
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

## Troubleshooting

1. **Google Sheets Issues**:
   - Verify service account has edit access to the spreadsheet
   - Check credentials JSON is properly formatted in .env
   - Ensure sheet name matches exactly: "Approvals"
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
