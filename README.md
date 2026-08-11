# Memo

## Workflow

**1. Locally.** Running the website locally is recommended to test changes before pushing commits.

```bash
# install the dependencies
npm install

# you will need to run these once
npx netlify login # requires being logged into netlify, ask for credentials
npx netlify link # when it asks what linking method to use, choose github

# The app will then be available locally for building with
 npx netlify dev

# Deprecated alternative
npm run dev
```

If you use `npx netlify dev` your serverless functions will also be available at:

```
GET http://localhost:8888/.netlify/functions/<function_file_name_without_extension>
```

**2. Deploying.** `main` is the only long-lived branch. Netlify publishes nil.moe from `main`
automatically on every push, so there is no separate staging or production branch and no manual
promotion step. Pull requests aren't really necessary due to the small team size, but if you'd
like code review send a PR to merge to `main`.

Because there is no buffer, merging to `main` goes straight to the live site. Netlify does build a
deploy preview for every PR, but Auth0's `redirect_uri` is derived from Netlify's `URL` variable,
which always points at production — so logging in from a preview bounces you to nil.moe. Anything
touching the login flow can only be exercised for real after it ships.

## Web Development Stack

We use:

- [Netlify](https://www.netlify.com) for web hosting and deployment
- [Node and NPM](https://nodejs.org) for runtime environment and package management
- [Eleventy](https://11ty.io) for static site generation
- A tiny inline JS pipeline with a [component-based architecture](https://medium.com/@dan.shapiro1210/understanding-component-based-architecture-3ff48ec0c238)
- Serverless (FaaS) development pipeline with [Netlify Dev](https://www.netlify.com/products/dev) and [Netlify Functions](https://www.netlify.com/products/functions)

**Credentials.**
This project is deployed via netlify with the account `{ask}` (ask me for password).

External API keys are set in [Netlify](https://app.netlify.com/sites/td-memo/settings/deploys#environment)
environment variables. They are also avaiable in production inside
`process.env`.

You might need to run `npx netlify login` inside the project.

**Netlify plugins.**

- Identity. Managed at https://app.netlify.com/sites/td-memo/identity
- FaunaDB. Managed at https://dashboard.fauna.com by logging in with netlify account integration.

**DB**

We currently use mongoDB, logged into via the MONGODB_URL

**Error handling.**
Error handling is done using `neverthrow`, which is similar to
Rust Result or FP Either. Learn more about its API at:
https://github.com/supermacro/neverthrow

**Current rate limits.**

- TV/Series

  - TMDB API: unlimited

- Google Books API

  - Potentially 1000/day with key, with easy free application for 100k (warning: old information)
    - Right now we're not using an API key. If you want to try, [then sign up for one](https://cloud.google.com/docs/authentication/api-keys?visit_id=637791358916015831-391700742&rd=1) and add GOOGLE_API_KEY to the Netlify environment variables. The code will automatically pick it up.

- Games
  - IGDB: 4 reqs/sec (currently fetching details takes 2 requests due to getting company names)
  - HLTB scraping: unknown but at least near-unlimited
