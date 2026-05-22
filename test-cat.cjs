const text = "Teve um episódio de vômito. Após outro episódio de vômito foi administrado Ondansetrona de SOS. Foi atendido pela fisioterapeuta Dayane. Tomou toda mamadeira das 09h";
fetch("http://localhost:3000/api/gemini/extractAndCategorizeActivities", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({text})
}).then(res => res.json()).then(console.log).catch(console.error);
