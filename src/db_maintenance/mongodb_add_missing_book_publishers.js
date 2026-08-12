#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const axios = require("axios").default;

const sleep = (seconds) =>
  new Promise((res) => setTimeout(res, seconds * 1000));

const client = new MongoClient(process.env.MONGODB_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

const main = async () => {
  await client.connect();
  const db = client.db("memo");
  const books = db.collection("books");

  // await logTestItemsToCheckHowTheDataLooksLike(books);
  await updateAllCachedGameEntriesWithoutPublishers(books);

  client.close();
};

const logTestItemsToCheckHowTheDataLooksLike = async (books) => {
  const booksData = await books.find().limit(2).toArray();
  console.log("Books:", JSON.stringify(booksData, null, 2));
};

const updateAllCachedGameEntriesWithoutPublishers = async (books) => {
  const cursor = books.find({
    apiRefs: {
      $elemMatch: {
        $regex: /^ISBN__/,
      },
    },
    publishers: { $exists: false },
  });

  while (await cursor.hasNext()) {
    const book = await cursor.next();
    const isbn = book.apiRefs
      .find((ref) => ref.startsWith("ISBN"))
      .replace("ISBN__", "");
    // `publishers` must end up a flat array of strings — see the bookParser
    // in ../api/utils/parsers/books.js. Await the response and take the first
    // result: an un-awaited Promise is stored by Mongo as an empty object,
    // and mapping over every result gives an array of arrays.
    const publisher = await axios({
      method: "get",
      url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`,
    })
      .then(({ data }) => data.items?.[0]?.volumeInfo?.publisher)
      .catch(() => undefined);

    const publishers = publisher ? [publisher] : undefined;

    if (publishers) {
      console.log("Adding missing publisher for ", book.englishTranslatedTitle);
      await books.updateOne({ _id: book._id }, { $set: { publishers } });
      await sleep(5);
    }
  }
};

main();
