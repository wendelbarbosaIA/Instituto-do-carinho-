export interface MedicalEventExtraction {
  patientName: string | null;
  date: string | null;
  type: 'medical_request' | 'medical_completed' | 'report';
  description: string;
}

export interface MedicalReportExtraction {
  patientName: string;
  reportType: string;
  date: string;
  findings: string;
  recommendations: string[];
}

export async function extractMedicalEventData(text: string, profiles: { name: string }[]): Promise<MedicalEventExtraction> {
  const response = await fetch('/api/gemini/extractMedicalEventData', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, profiles })
  });
  if (!response.ok) {
    throw new Error('Falha na API (' + response.status + '): ' + await response.text());
  }
  return await response.json();
}

export interface ExtractedActivity {
  description: string;
  category: 'alimentacao' | 'intercorrencia' | 'sos' | 'cuidados_extras' | 'rotina';
  time?: string | null;
}

export async function extractAndCategorizeActivities(text: string): Promise<ExtractedActivity[]> {
  const response = await fetch('/api/gemini/extractAndCategorizeActivities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    return [];
  }
  return await response.json();
}

export async function generateRoomSummary(room: string, 
  lastReport: { generalInfo?: string; importantInfo?: string } | undefined, 
  roomActivities: { childName: string; timestamp: Date; description: string }[], 
  childrenNames: string[],
  temporaryMedications: { childName: string; medications: { description: string; endDate: string; endTime: string; times?: string[] }[] }[],
  legacyReportsInfo?: string[]
): Promise<string> {
  const response = await fetch('/api/gemini/generateRoomSummary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, lastReport, roomActivities, childrenNames, temporaryMedications, legacyReportsInfo })
  });
  if (!response.ok) {
    throw new Error('Falha na API (' + response.status + '): ' + await response.text());
  }
  const textContent = await response.text();
  if (textContent.includes("<!DOCTYPE html>") || textContent.includes("<html")) {
      throw new Error("HTML recebido. O app parece estar rodando em front-end estático sem servidor backend (como no Netlify).");
  }
  return textContent;
}

export async function extractMedicalReportData(images: { base64: string; mimeType: string }[]): Promise<MedicalReportExtraction> {
  const response = await fetch('/api/gemini/extractMedicalReportData', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images })
  });
  if (!response.ok) {
    throw new Error('Falha na API (' + response.status + '): ' + await response.text());
  }
  return await response.json();
}
