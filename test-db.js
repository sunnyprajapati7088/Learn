import "dotenv/config";
import mongoose from "mongoose";

const BookSchema = new mongoose.Schema({}, { strict: false });
const Book = mongoose.model("Book", BookSchema);

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const count = await Book.countDocuments();
    console.log("Mongoose Books Count:", count);
    const docs = await Book.find({}, { chunks: 0 }); // Exclude massive chunks
    console.log("Docs:", JSON.stringify(docs, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
