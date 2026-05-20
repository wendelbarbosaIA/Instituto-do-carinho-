import { activities } from './src/App';
console.log('Script to test simple excretion string matching.')

const desc = "Evacuou";
const d = desc.toLowerCase();
const isSimpleExcretion = 
  !d.includes('diarreia') && !d.includes('diarréia') &&
  (d.includes('diurese') || d.includes('urina') || d.includes('xixi') || d.includes('número 1') || d.includes('numero 1') ||
   d.includes('evacua') || d.includes('fezes') || d.includes('cocô') || d.includes('coco') || d.includes('fez o 2') || d.includes('número 2') || d.includes('numero 2'));

console.log("isSimpleExcretion:", isSimpleExcretion);
