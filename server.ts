import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

let aiClient: GoogleGenAI | null = null;
function getAI() {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is required.");
    }
    aiClient = new GoogleGenAI({ apiKey: key });
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));

  // API Routes
  app.post("/api/gemini/extractMedicalEventData", async (req, res) => {
    try {
      const { text, profiles } = req.body;
      const profileNames = profiles.map((p: any) => p.name).join(", ");
      
      const response = await getAI().models.generateContent({
        model: "gemini-flash-latest",
        contents: {
          parts: [
            {
              text: `Analise o seguinte texto de registro de uma instituição de carinho: "${text}".
              
              Extraia:
              1. O nome do paciente (deve ser um destes: ${profileNames}). Se não encontrar nenhum, retorne null.
              2. A data do evento ou agendamento (se houver). Retorne no formato YYYY-MM-DD. Se não houver data, retorne null.
              3. O tipo do evento: 'medical_request' (se for uma solicitação de consulta/exame), 'medical_completed' (se for algo já realizado) ou 'report' (se for apenas um relato geral).
              4. Uma descrição resumida e profissional do evento. IMPORTANTE: Não inclua o nome do paciente ou termos como "o paciente", "a paciente" ou "a criança" no início da descrição. Comece diretamente com a ação ou o fato ocorrido (ex: "Teve febre e foi administrado dipirona" em vez de "O paciente teve febre...").
              
              Retorne os dados em formato JSON estruturado.`,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              patientName: { type: Type.STRING, nullable: true },
              date: { type: Type.STRING, nullable: true },
              type: { type: Type.STRING, enum: ['medical_request', 'medical_completed', 'report'] },
              description: { type: Type.STRING },
            },
            required: ["patientName", "date", "type", "description"],
          },
        },
      });

      const resultText = response.text;
      if (!resultText) throw new Error("Não foi possível processar o texto.");
      res.json(JSON.parse(resultText));
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/gemini/extractAndCategorizeActivities", async (req, res) => {
    try {
      const { text } = req.body;
      const response = await getAI().models.generateContent({
        model: "gemini-flash-latest",
        contents: {
          parts: [
            {
              text: `Analise o seguinte relato: "${text}".
              
              O usuário inseriu um texto relatando um ou mais eventos. O seu papel é identificar as atividades e dividi-las em categorias caso o usuário relate informações de categorias diferentes no mesmo texto (exemplo: se falou sobre alimentação e também sobre um pico de febre, separe em dois objetos). Se todo o texto for sobre uma mesma categoria, retorne apenas um objeto.
              Para cada parte, extraia a descrição daquela ação específica de forma fiel ao que foi relatado.
              
              Categorias possíveis:
              - 'alimentacao': Introdução alimentar, fórmulas, suplementos, refeições.
              - 'intercorrencia': Febres, dores, convulsões, vômitos, quedas, alteração de saúde.
              - 'sos': Medicações de SOS administradas (extrajamente para corrigir sintomas eventuais como febre, dor, etc).
              - 'medicacao_rotina': Medicações padrão, de rotina, já da prescrição do paciente (anticonvulsivantes diários, etc).
              - 'cuidados_extras': Soro de reidratação, lavagens nasal, corte de cabelo/unhas, trocas de curativo, fisioterapias.
              - 'rotina': Banho, troca de fralda normal, sono, brincadeiras, atividades pedagógicas.
              
              Extraia também o horário (time) se mencionado no formato HH:mm. Se não houver, null.
              
              Retorne um JSON de array 'activities' contendo os eventos extraídos.`,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              activities: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    description: { type: Type.STRING },
                    category: { type: Type.STRING, enum: ['alimentacao', 'intercorrencia', 'sos', 'medicacao_rotina', 'cuidados_extras', 'rotina'] },
                    time: { type: Type.STRING, nullable: true },
                  },
                  required: ["description", "category", "time"],
                },
              },
            },
            required: ["activities"],
          },
        },
      });

      const resultText = response.text;
      if (!resultText) {
        res.json([]);
        return;
      }
      const result = JSON.parse(resultText);
      res.json(Array.isArray(result.activities) ? result.activities : []);
    } catch (e: any) {
      console.error(e);
      res.json([]);
    }
  });

  app.post("/api/gemini/generateRoomSummary", async (req, res) => {
    try {
      const { room, lastReport, roomActivities, childrenNames, temporaryMedications, legacyReportsInfo } = req.body;
      
      const reportContent = lastReport ? `Informações do último plantão:
Geral: ${lastReport.generalInfo || 'Nada'}
Importante: ${lastReport.importantInfo || 'Nada'}` : 'Sem informações do plantão anterior.';

      const activitiesContent = roomActivities.map((a: any) => `- ${a.childName} (${new Date(a.timestamp).toLocaleTimeString('pt-BR')}): ${a.description}`).join('\n');
      
      const medsContent = temporaryMedications.map((pm: any) => 
        `- ${pm.childName}:\n` + (Array.isArray(pm.medications) ? pm.medications.map((m: any) => `  * ${m.description} ${m.times && m.times.length > 0 ? `(${m.times.join(', ')})` : ''} - Até ${m.endDate} às ${m.endTime}`).join('\n') : 'Sem medicações')
      ).join('\n');

      const legacyContent = legacyReportsInfo && legacyReportsInfo.length > 0 
        ? `\nRelatórios de Plantão (Legacy) Feitos Recentes:\n${legacyReportsInfo.join('\n\n')}` 
        : '';

      const prompt = `Você é um assistente do Instituto do Carinho. Gere um resumo **SUPER RÁPIDO E DIRETO** da enfermaria '${room}' para a equipe.
Aqui estão as informações:

Crianças: ${childrenNames.join(', ')}

${reportContent}
${legacyContent}

Atividades (últimas 24h):
${activitiesContent || 'Nenhuma.'}

Medicações Temp. Ativas:
${medsContent || 'Nenhuma.'}

INSTRUÇÕES:
- Formato leitura rápida (máximo 10 a 15 segundos).
- Ignore informações normais/tranquilas.
- FOQUE APENAS em 3 coisas: Alertas graves, sintomas/SOS, medicações temporárias vencendo.
- Escreva em tópicos curtos (bullet points).
- Sem nenhuma introdução (ex: "Aqui está o resumo"), apenas entregue os tópicos. Use markdown pra ser limpo.`;

      const response = await getAI().models.generateContent({
        model: "gemini-flash-latest",
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      });

      res.send(response.text || 'Resumo da enfermaria não gerado.');
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/gemini/extractMedicalReportData", async (req, res) => {
    try {
      const { images } = req.body;
      
      const response = await getAI().models.generateContent({
        model: "gemini-flash-latest",
        contents: {
          parts: [
            ...images.map((img: any) => ({
              inlineData: {
                mimeType: img.mimeType,
                data: img.base64,
              },
            })),
            {
              text: "Analise este relatório médico ou resultado de exame (pode conter várias páginas/imagens). Extraia o nome do paciente, o tipo de relatório/exame, a data da realização, os principais achados/resultados e as recomendações médicas. Retorne os dados em formato JSON estruturado.",
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              patientName: {
                type: Type.STRING,
                description: "Nome completo do paciente encontrado no relatório.",
              },
              reportType: {
                type: Type.STRING,
                description: "Tipo do exame ou consulta (ex: Hemograma, Consulta Pediátrica, Raio-X).",
              },
              date: {
                type: Type.STRING,
                description: "Data da realização do exame ou consulta no formato YYYY-MM-DD.",
              },
              findings: {
                type: Type.STRING,
                description: "Resumo dos principais achados ou resultados do exame.",
              },
              recommendations: {
                type: Type.ARRAY,
                items: {
                  type: Type.STRING,
                },
                description: "Lista de recomendações médicas ou próximos passos.",
              },
            },
            required: ["patientName", "reportType", "date", "findings", "recommendations"],
          },
        },
      });

      const text = response.text;
      if (!text) throw new Error("Não foi possível extrair dados do relatório.");
      res.json(JSON.parse(text));
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // Vite Middleware
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
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
