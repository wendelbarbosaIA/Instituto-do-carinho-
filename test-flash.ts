import { GoogleGenAI } from "@google/genai";
async function test() {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    const res = await ai.models.generateContent({
      model: "gemini-flash-latest",
      contents: "Hello world"
    });
    console.log("SUCCESS:", res.text);
  } catch(e) {
    console.error("ERROR:");
    console.error(e);
  }
}
test();
