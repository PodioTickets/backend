/**
 * Converte os ícones 3D de modalidade (webp) para PNG.
 *
 * Por quê: o `@react-pdf/renderer` (usado no PDF de detalhes da inscrição) NÃO
 * decodifica WebP, e converter em runtime via `sharp` depende do binário do
 * ambiente suportar WebP (pode falhar em produção). Pré-convertemos aqui, uma
 * única vez em dev, e versionamos os PNGs em `src/common/assets/modalities/` —
 * o template referencia o PNG local direto (mesmo padrão do logo).
 *
 * Uso: `npx ts-node scripts/convert-modality-icons.ts`
 * Re-rodar sempre que um ícone de modalidade mudar/for adicionado.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as sharpLib from 'sharp';

const sharp = (sharpLib as any).default ?? sharpLib;

const DIR = path.join(__dirname, '..', 'src', 'common', 'assets', 'modalities');
const SIZE = 128; // renderizado a ~24px no PDF; 128 dá nitidez com arquivo pequeno.

async function main() {
  const webps = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.webp'));
  if (!webps.length) {
    console.log('Nenhum .webp em', DIR);
    return;
  }
  for (const file of webps) {
    const out = file.replace(/\.webp$/i, '.png');
    const png = await sharp(path.join(DIR, file))
      // `contain` + fundo transparente: não corta o ícone 3D.
      .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(DIR, out), png);
    console.log(`convertido ${file} -> ${out} (${png.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
