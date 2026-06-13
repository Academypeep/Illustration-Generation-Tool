import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Configure body parsers to handle base64 image uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true, parameterLimit: 50000 }));

  // Shared Gemini client utility (lazy initialization)
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    if (!aiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is required. Please configure it in your Settings > Secrets tab.");
      }
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiClient;
  }

  // --- API Endpoints ---

  // Check backend and API key status
  app.get("/api/config", (req, res) => {
    res.json({
      success: true,
      hasApiKey: !!process.env.GEMINI_API_KEY,
    });
  });

  // Promote prompt structure and context
  app.post("/api/enhance-prompt", async (req, res) => {
    try {
      const { prompt, style } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required." });
      }

      const ai = getGeminiClient();

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Short Prompt Concept: "${prompt}"\nTarget Style: "${style || 'Digital Illustration'}"`,
        config: {
          systemInstruction: "You are an expert prompt engineer specializing in visual design and illustration styles. Your task is to take a short creative concept/prompt and a target style, and return a highly detailed, descriptive image generation prompt. Focus strictly on visual composition, colors, lighting, texture, and style cues. Return ONLY the enhanced prompt as plain text, without any introductory or concluding text, bullet points, markdowns, code blocks, or quotes."
        }
      });

      res.json({
        success: true,
        enhancedPrompt: response.text?.trim() || prompt,
      });
    } catch (error: any) {
      console.error("Error in /api/enhance-prompt:", error);
      res.status(500).json({ error: error.message || "An error occurred during prompt enhancement." });
    }
  });

  // Core generate illustration endpoint
  app.post("/api/generate-image", async (req, res) => {
    try {
      const { prompt, model, aspectRatio, imageSize } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required." });
      }

      const ai = getGeminiClient();
      const selectedModel = model || "gemini-2.5-flash-image";

      const parts = [{ text: prompt }];
      const config: any = {};

      if (selectedModel === "gemini-3.1-flash-image-preview" || selectedModel === "gemini-2.5-flash-image") {
        config.imageConfig = {
          aspectRatio: aspectRatio || "1:1",
        };
        if (selectedModel === "gemini-3.1-flash-image-preview") {
          config.imageConfig.imageSize = imageSize || "1K";
        }
      }

      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: { parts },
        config,
      });

      let foundImageBase64 = null;
      let textFeedback = "";

      if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            foundImageBase64 = part.inlineData.data;
          } else if (part.text) {
            textFeedback += (textFeedback ? "\n" : "") + part.text;
          }
        }
      }

      if (!foundImageBase64) {
        return res.status(500).json({
          error: "No image was returned by the model. Feedback: " + (textFeedback || "None")
        });
      }

      res.json({
        success: true,
        image: `data:image/png;base64,${foundImageBase64}`,
        feedback: textFeedback,
      });
    } catch (error: any) {
      console.error("Error in /api/generate-image:", error);
      res.status(500).json({ error: error.message || "An error occurred during image generation." });
    }
  });

  // Edit / Restructure existing generated illustration
  app.post("/api/edit-image", async (req, res) => {
    try {
      const { base64Image, mimeType, prompt, model } = req.body;
      if (!base64Image || !prompt) {
        return res.status(400).json({ error: "Both baseline image (base64) and edit prompt are required." });
      }

      const cleanBase64 = base64Image.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
      const cleanMimeType = mimeType || "image/png";

      const ai = getGeminiClient();
      const selectedModel = model || "gemini-2.5-flash-image";

      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: {
          parts: [
            {
              inlineData: {
                data: cleanBase64,
                mimeType: cleanMimeType,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      });

      let foundImageBase64 = null;
      let textFeedback = "";

      if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            foundImageBase64 = part.inlineData.data;
          } else if (part.text) {
            textFeedback += (textFeedback ? "\n" : "") + part.text;
          }
        }
      }

      if (!foundImageBase64) {
        return res.status(500).json({
          error: "No output image was returned by the editing model. Feedback: " + (textFeedback || "None")
        });
      }

      res.json({
        success: true,
        image: `data:image/png;base64,${foundImageBase64}`,
        feedback: textFeedback,
      });
    } catch (error: any) {
      console.error("Error in /api/edit-image:", error);
      res.status(500).json({ error: error.message || "An error occurred during image editing." });
    }
  });

  // --- Serve Frontend Application ---

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
