# team4-enfuce

## Description
This repository contains a light React-based front-end to make programmatic API calls to the Snowflake agentic system.

## Installation
- Install NodeJS (v25 preferred).
- Clone the repository somewhere and `cd` into the directory.
- Run `npm install`

## Usage
### .env file
To run with the database used in the proof-of-concept, you have to have an .env file with the right parameters. It should look as follows:
```
VITE_SNOWFLAKE_PAT=<SNOWFLAKE_PERSONAL_ACCESS_TOKEN>
VITE_SNOWFLAKE_ACCOUNT=<SNOWFLAKE_USER_ID>
VITE_SNOWFLAKE_DATABASE=TARGETS_DEMO
VITE_SNOWFLAKE_SCHEMA=PUBLIC
VITE_SNOWFLAKE_AGENT=KENT_AGENT
```
You can ask a team member for the credentials, as they won't be committed here.

### Run
Start the tool by running `npm run dev` and navigate to `http://localhost:3000` using your preferred browser.