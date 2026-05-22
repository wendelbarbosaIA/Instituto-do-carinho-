import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config({ override: true });

function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === "your_api_key_here" || apiKey === "MY_GEMINI_API_KEY" || apiKey.includes('MY_GE')) {
    throw new Error("A chave da API do Gemini configurada é inválida ou é um placeholder (" + apiKey + "). Por favor, insira uma chave válida no menu Settings > Secrets no AI Studio.");
  }
  return new GoogleGenAI({ apiKey: apiKey.trim() });
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
      
      const ai = getAI();
      const response = await ai.models.generateContent({
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
      if (e.message && e.message.includes('API key not valid')) {
        return res.status(500).json({ error: "A chave da API do Gemini configurada é inválida. Por favor, atualize-a no menu Settings (Secrets) do projeto." });
      }
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post("/api/gemini/extractAndCategorizeActivities", async (req, res) => {
    try {
      const { text } = req.body;
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: {
          parts: [
            {
              text: `Analise o seguinte relato logado em texto livre: "${text}".
              
              O usuário inseriu um texto relatando um ou mais eventos (rotinas, sintomas, medicações, intercorrências, etc). O seu papel MUITO IMPORTANTE é identificar *tudo* o que foi relatado e **dividir em objetos/categorias separadas** caso o usuário relate informações de categorias diferentes num único texto. 
              Por exemplo: se ele disse "Apresentou febre e dei dipirona, também aceitou bem o almoço e tomou soro", você DEVE separar em categorias: Intercorrência, SOS, Alimentação, Cuidados Extras.
              Para cada parte, extraia a descrição daquela ação específica de forma fiel, clara e concisa.
              
              Categorias MANDATÓRIAS (classifique os eventos nestas categorias):
              - 'alimentacao': (🍼 Alimentação) Fórmulas, suplementos, almoço/jantar, lanches, mamadas e introdução alimentar e similares.
              - 'intercorrencia': (⚠️ Intercorrências) Febres, sintomas, dores, vômitos, convulsões, quedas, choros, agitações, ou qualquer alteração no quadro de saúde e similares.
              - 'sos': (💊 Medicações SOS) Remédios usados apenas em caso de necessidade sob demanda (ex: dipirona pra febre, ibuprofeno pra dor, etc) e similares.
              - 'cuidados_extras': (➕ Cuidados Extras) Soro de hidratação, inalação extra, lavagem nasal, cortes de unhas, curativos ou fisioterapia e similares.
              - 'medicacao_rotina': (💊 Medicações de Rotina) Medicações padrão/continuadas (ex: anticonvulsivantes diários).
              - 'rotina': Banho, troca de fralda normal, sono, brincadeiras, atividades normais da rotina.
              
              REQUISITO DE HORÁRIO/HORA:
              Sempre que houver uma hora/horário digitado ou mencionado no relato correspondente à ação (ex: "das 9h", "às 10:15", "sono às 10h15", "dipirona às 14:30"), você DEVE:
              1. Extrair o horário correspondente no campo 'time' no formato HH:mm (ex: "09:00", "10:15", "14:30"). Se não houver, deixe null.
              2. OBRIGATORIAMENTE ajustar o começo do campo 'description', adicionando o horário no formato de colchetes '[XXhYY]' ou '[XXh]' (se for hora cheia, ex: '[09h]' em vez de '[09h00]', e '[14h30]').
              3. Remover a menção redundante do horário do restante da descrição.
              
              Exemplos de ajuste de descrição:
              - Input: "Tomou toda a mamadeira das 9h" -> description: "[09h] Tomou toda a mamadeira", time: "09:00"
              - Input: "Teve febre às 14h30" -> description: "[14h30] Teve febre", time: "14:30"
              - Input: "Colocado para dormir às 13:00" -> description: "[13h] Colocado para dormir", time: "13:00"
              - Input: "Inalação às 11h" -> description: "[11h] Inalação", time: "11:00"
              
              Retorne uma ARRAY contendo no mínimo 1 evento, e mais eventos se houverem várias ações listadas de tipos diferentes no relato.`,
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
      const RawActivities = Array.isArray(result.activities) ? result.activities : [];

      // Certificar via pós-processamento robusto que o formato [XXh] ou [XXhYY] do horário está no início da descrição
      const activities = RawActivities.map((act: any) => {
        if (!act.time || !act.description) return act;

        let desc = act.description.trim();
        const timeMatch = act.time.match(/^(\d{1,2}):(\d{2})$/);
        if (timeMatch) {
          const hr = String(parseInt(timeMatch[1], 10)).padStart(2, '0');
          const min = String(parseInt(timeMatch[2], 10)).padStart(2, '0');
          const bracket = min === "00" ? `[${hr}h]` : `[${hr}h${min}]`;

          if (!desc.startsWith(bracket)) {
            // Remove qualquer prefixo legado de colchetes de tempo (ex: "[09:00]" ou "[9h]")
            desc = desc.replace(/^\[\d{1,2}(:|h)\d{0,2}\]?\s*/, "");
            desc = `${bracket} ${desc}`;
          }
        }
        return {
          ...act,
          description: desc
        };
      });

      res.json(activities);
    } catch (e: any) { 
      if (e.message && e.message.includes('API key not valid')) {
        return res.status(500).json({ error: "A chave da API do Gemini configurada é inválida. Por favor, atualize-a no menu Settings (Secrets) do projeto." });
      }
      res.status(500).json({ error: e.message || String(e) });
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

      const prompt = `Você é um assistente de IA para uma instituição de carinho infantil. Gere um resumo geral da enfermaria '${room}' para preparar a equipe para o plantão atual.
Aqui estão as informações:

Crianças nesta enfermaria: ${childrenNames.join(', ')}

${reportContent}
${legacyContent}

Atividades registradas hoje (nas últimas 24 horas):
${activitiesContent || 'Nenhuma atividade registrada hoje ainda.'}

Medicações Temporárias Ativas:
${medsContent || 'Nenhuma medicação temporária ativa.'}

Gere um resumo em português, claro, profissional e empático, destacando os pontos principais (alertas graves, evolução de medicações de SOS se houver, pontos de atenção, e medicações temporárias que necessitam atenção/vigilância ou que terminam em breve). 
Não invente informações e escreva de forma em um formato bem fácil e rápido de ler. Use markdown com negrito para destacar nomes/termos importantes, e use listas de marcadores para facilitar a leitura. Máximo de 3 tópicos gerais. Não precisa de cumprimento inicial.`;

      const ai = getAI();
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      });

      res.send(response.text || 'Resumo da enfermaria não gerado.');
    } catch (e: any) { 
      if (e.message && e.message.includes('API key not valid')) {
        return res.status(500).json({ error: "A chave da API do Gemini configurada é inválida. Por favor, atualize-a no menu Settings (Secrets) do projeto." });
      }
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post("/api/gemini/extractMedicalReportData", async (req, res) => {
    try {
      const { images } = req.body;
      
      const ai = getAI();
      const response = await ai.models.generateContent({
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
      if (e.message && e.message.includes('API key not valid')) {
        return res.status(500).json({ error: "A chave da API do Gemini configurada é inválida. Por favor, atualize-a no menu Settings (Secrets) do projeto." });
      }
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post("/api/gemini/analyzeLegacyReport", async (req, res) => {
    try {
      const { parts } = req.body;
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: { parts }
      });
      res.send(response.text || "");
    } catch (e: any) { 
      if (e.message && e.message.includes('API key not valid')) {
        return res.status(500).json({ error: "A chave da API do Gemini configurada é inválida. Por favor, atualize-a no menu Settings (Secrets) do projeto." });
      }
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post("/api/gemini/aiSearch", async (req, res) => {
    try {
      const { prompt } = req.body;
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        config: {
          systemInstruction: "Você é um assistente especializado em gestão de plantão para um instituto de cuidados de crianças especiais. Seja empático, preciso e útil."
        },
        contents: prompt
      });
      res.send(response.text || "Desculpe, não consegui processar sua pergunta.");
    } catch (e: any) { 
      if (e.message && e.message.includes('API key not valid')) {
        return res.status(500).json({ error: "A chave da API do Gemini configurada é inválida. Por favor, atualize-a no menu Settings (Secrets) do projeto." });
      }
      res.status(500).json({ error: e.message || String(e) });
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
