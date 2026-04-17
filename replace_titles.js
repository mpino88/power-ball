const fs = require('fs');
const path = require('path');

const replacements = {
  "Más salidores x día de la Semana": "Días de Suerte (Top por Día)",
  "Más salidores x día de la semana": "Días de Suerte (Top por Día)",
  "Más salidores x día": "Días de Suerte (Top por Día)",
  "Análisis de Frecuencia": "Radar de Frecuencias",
  "Números Debidos (Gap)": "Cazador de Rezagados (Gap)",
  "Seguidor de Secuencias": "Rastreador de Secuencias",
  "Momentum de Tendencia - Pro*": "Fuerza de Tendencia Pro*",
  "Momentum de Tendencia": "Fuerza de Tendencia Pro*",
  "Análisis Posicional": "Radiografía Posicional",
  "Consenso Multi-Estrategia": "Visión 360° (Consenso)",
  "Est. Individuales (Hot)": "Fiebre de Números (Hot)",
  "Markov Orden 2 - Pro*": "IA Predictiva Pro* (Markov)",
  "Markov Orden 2": "IA Predictiva Pro* (Markov)",
  "Cadena de Markov Orden 2": "IA Predictiva Pro* (Markov)",
  "Familias de Decenas": "Bloques Ganadores (Familias)",
  "Espejo y Complemento": "Sincronía Oculta (Espejo y complemento)",
  "Detector de Ciclos - Pro*": "Radar de Ciclos Pro*",
  "Detector de Ciclos": "Radar de Ciclos Pro*",
  "Análisis de Rachas - Pro*": "Detector de Rachas Pro*",
  "Análisis de Rachas": "Detector de Rachas Pro*",
  "Score Bayesiano": "Fórmula de Éxito (Bayesiano)"
};

function walkSync(dir, filelist) {
  var files = fs.readdirSync(dir);
  filelist = filelist || [];
  files.forEach(function (file) {
    if (fs.statSync(path.join(dir, file)).isDirectory()) {
      filelist = walkSync(path.join(dir, file), filelist);
    }
    else {
      if (file.endsWith('.ts')) {
        filelist.push(path.join(dir, file));
      }
    }
  });
  return filelist;
}

const files = walkSync('./src');
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let newContent = content;
  for (const [oldStr, newStr] of Object.entries(replacements)) {
    newContent = newContent.split(oldStr).join(newStr);
  }
  if (newContent !== content) {
    fs.writeFileSync(file, newContent, 'utf8');
    console.log(`Updated ${file}`);
  }
});
