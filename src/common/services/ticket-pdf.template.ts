import React from 'react';
import {
  Document,
  Page,
  View,
  Text,
  Image,
  Font,
  Svg,
  Path,
  Defs,
  LinearGradient as LinearGradientBase,
  Stop,
} from '@react-pdf/renderer';
import * as path from 'path';
import {
  TicketPdfProduct,
  TicketPdfRegistrationWithQr,
  TicketPdfTemplateData,
} from './ticket-pdf.types';

const LinearGradient = LinearGradientBase as any;

Font.registerHyphenationCallback((w) => [w]);

const FP = path.join(process.cwd(), 'node_modules', '@fontsource');
const dmSans = (w: number) =>
  path.join(FP, 'dm-sans', 'files', `dm-sans-latin-${w}-normal.woff`);
const manrope = (w: number) =>
  path.join(FP, 'manrope', 'files', `manrope-latin-${w}-normal.woff`);

Font.register({
  family: 'DM Sans',
  fonts: [
    { src: dmSans(400), fontWeight: 400 },
    { src: dmSans(500), fontWeight: 500 },
    { src: dmSans(600), fontWeight: 600 },
    { src: dmSans(700), fontWeight: 700 },
  ],
});

Font.register({
  family: 'Manrope',
  fonts: [
    { src: manrope(700), fontWeight: 700 },
    { src: manrope(800), fontWeight: 800 },
  ],
});

const C = {
  gray12: '#202020',
  gray11: '#646464',
  gray6: '#D9D9D9',
  gray2: '#F9F9F9',
  gray1: '#FCFCFC',
  green3: '#DAF1DB',
  green12: '#203C25',
  blue3: '#DEF7F9',
  blue12: '#0D3C48',
  white: '#FFFFFF',
} as const;

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('pt-BR');
}

function fmtDateTime(d: Date): string {
  const day = d.toLocaleDateString('pt-BR');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} · ${hh}h${mm}`;
}

function fmtCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const HR = () =>
  React.createElement(View, { style: { height: 1, backgroundColor: C.gray6 } });

/* Campo de informação: label 16px + value 16px 500, ambos gray12 */
const FieldItem = ({ label, value }: { label: string; value: string }) =>
  React.createElement(
    View,
    { style: { paddingVertical: 8, gap: 12 } },
    React.createElement(
      Text,
      { style: { fontFamily: 'DM Sans', fontSize: 16, fontWeight: 400, color: C.gray12 } },
      label,
    ),
    React.createElement(
      Text,
      { style: { fontFamily: 'DM Sans', fontSize: 16, fontWeight: 500, color: C.gray12 } },
      value || '—',
    ),
  );

/* Card de produto: imagem 100×100, nome 14px 600, preço 14px 700 */
const ProductCard = ({ product }: { product: TicketPdfProduct }) =>
  React.createElement(
    View,
    {
      style: {
        width: '48%',
        backgroundColor: C.gray2,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.gray6,
        borderStyle: 'solid',
      },
    },
    React.createElement(
      View,
      {
        style: {
          padding: 16,
          borderBottomWidth: 1,
          borderBottomColor: C.gray6,
          borderBottomStyle: 'solid',
          flexDirection: 'row',
          gap: 12,
          alignItems: 'flex-start',
        },
      },
      product.imageUrl
        ? React.createElement(Image, {
            src: product.imageUrl,
            style: { width: 100, height: 100, borderRadius: 8, objectFit: 'fill' },
          })
        : React.createElement(View, {
            style: { width: 100, height: 100, borderRadius: 8, backgroundColor: C.gray6 },
          }),
      React.createElement(
        View,
        { style: { flex: 1, gap: 6, paddingVertical: 8, justifyContent: 'space-between' } },
        React.createElement(
          Text,
          { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 600, color: C.gray12 } },
          product.name,
        ),
        React.createElement(
          Text,
          { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 700, color: C.gray12 } },
          fmtCurrency(product.price),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: { paddingTop: 16, paddingBottom: 12, paddingHorizontal: 16, gap: 16 } },
      product.variationName
        ? React.createElement(
            View,
            { style: { flexDirection: 'row', gap: 4 } },
            React.createElement(
              Text,
              { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 400, color: C.gray12 } },
              'Tamanho: ',
            ),
            React.createElement(
              Text,
              { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 600, color: C.gray12 } },
              product.variationName,
            ),
          )
        : null,
      React.createElement(
        View,
        {
          style: {
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: product.isIncluded ? C.green3 : C.blue3,
            borderRadius: 8,
            alignSelf: 'flex-start',
          },
        },
        React.createElement(
          Text,
          {
            style: {
              fontFamily: 'DM Sans',
              fontSize: 14,
              fontWeight: 500,
              color: product.isIncluded ? C.green12 : C.blue12,
            },
          },
          product.isIncluded ? 'Incluso' : 'Adicional',
        ),
      ),
    ),
  );

/* Card de participante — wrap: false garante que o card não é dividido entre páginas */
const ParticipantCard = ({ reg }: { reg: TicketPdfRegistrationWithQr }) => {
  const fields = [
    reg.email ? { label: 'Email', value: reg.email } : null,
    reg.cpf ? { label: 'CPF', value: reg.cpf } : null,
    reg.dateOfBirth ? { label: 'Data de nascimento', value: fmtDate(reg.dateOfBirth) } : null,
    reg.phone ? { label: 'Telefone', value: reg.phone } : null,
    reg.gender ? { label: 'Sexo', value: reg.gender } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  return React.createElement(
    View,
    {
      style: {
        backgroundColor: C.gray1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.gray6,
        borderStyle: 'solid',
        marginTop: 16,
      },
    },
    /* Cabeçalho: QR 80×80 + nome/ticket */
    React.createElement(
      View,
      {
        style: {
          padding: 20,
          borderBottomWidth: 1,
          borderBottomColor: C.gray6,
          borderBottomStyle: 'solid',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 16,
        },
      },
      React.createElement(Image, { src: reg.qrDataUrl, style: { width: 80, height: 80 } }),
      React.createElement(
        View,
        { style: { gap: 16 } },
        React.createElement(
          Text,
          { style: { fontFamily: 'DM Sans', fontSize: 16, fontWeight: 400, color: C.gray12 } },
          `Participante ${reg.index}`,
        ),
        React.createElement(
          Text,
          { style: { fontFamily: 'Manrope', fontSize: 18, fontWeight: 700, color: C.gray12 } },
          reg.participantName,
        ),
        React.createElement(
          View,
          { style: { flexDirection: 'row', gap: 4 } },
          React.createElement(
            Text,
            { style: { fontFamily: 'DM Sans', fontSize: 16, fontWeight: 400, color: C.gray11 } },
            'Ingresso: ',
          ),
          React.createElement(
            Text,
            { style: { fontFamily: 'Manrope', fontSize: 16, fontWeight: 600, color: C.gray12 } },
            reg.ticketName,
          ),
        ),
      ),
    ),
    /* Seção: informações do participante */
    fields.length > 0
      ? React.createElement(
          View,
          { style: { paddingHorizontal: 20, paddingVertical: 24, gap: 20 } },
          React.createElement(
            Text,
            { style: { fontFamily: 'Manrope', fontSize: 18, fontWeight: 800, color: C.gray12 } },
            'Informações do participante',
          ),
          React.createElement(
            View,
            null,
            ...fields.map((f, i) =>
              React.createElement(FieldItem, { key: i, label: f.label, value: f.value }),
            ),
          ),
        )
      : null,
    /* Seção: perguntas do organizador */
    ...(reg.questionAnswers.length > 0
      ? [
          React.createElement(
            View,
            { style: { marginHorizontal: 16 } },
            React.createElement(HR, null),
          ),
          React.createElement(
            View,
            { style: { paddingHorizontal: 20, paddingVertical: 24, gap: 20 } },
            React.createElement(
              Text,
              { style: { fontFamily: 'Manrope', fontSize: 18, fontWeight: 800, color: C.gray12 } },
              'Perguntas do Organizador',
            ),
            React.createElement(
              View,
              null,
              ...reg.questionAnswers.map((qa, i) =>
                React.createElement(FieldItem, { key: i, label: qa.question, value: qa.answer }),
              ),
            ),
          ),
        ]
      : []),
    /* Seção: produtos do kit */
    ...(reg.products.length > 0
      ? [
          React.createElement(
            View,
            { style: { marginHorizontal: 16 } },
            React.createElement(HR, null),
          ),
          React.createElement(
            View,
            { style: { paddingHorizontal: 20, paddingVertical: 24, gap: 20 } },
            React.createElement(
              Text,
              { style: { fontFamily: 'Manrope', fontSize: 18, fontWeight: 800, color: C.gray12 } },
              'Produtos do kit',
            ),
            React.createElement(
              View,
              { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 } },
              ...reg.products.map((p, i) =>
                React.createElement(ProductCard, { key: i, product: p }),
              ),
            ),
          ),
        ]
      : []),
  );
};

const LogoVector = () =>
  React.createElement(
    Svg,
    { width: 29, height: 28, viewBox: '0 0 29 28' },
    React.createElement(
      Defs,
      null,
      React.createElement(
        LinearGradient,
        {
          id: 'lgrad',
          x1: '22.5514',
          y1: '-1.14754',
          x2: '0.808587',
          y2: '28.4166',
          gradientUnits: 'userSpaceOnUse',
        },
        React.createElement(Stop, { offset: '0', stopColor: '#57D321' }),
        React.createElement(Stop, { offset: '0.523222', stopColor: '#1CB757' }),
        React.createElement(Stop, { offset: '1', stopColor: '#18773D' }),
      ),
    ),
    React.createElement(Path, {
      d: 'M28.023 12.4933C27.1431 11.4496 25.8464 10.8458 24.482 10.8458H18.8104C18.1477 10.8458 17.5122 11.1017 17.0364 11.5617L0 28L6.70384 11.0729C6.96406 10.4145 7.60094 9.98316 8.30828 9.98316H15.1156C15.8833 9.98316 16.4656 9.35346 16.4656 8.63463C16.4656 8.5038 16.4469 7.07476 16.4067 6.94249C16.2327 6.37462 15.7079 5.98788 15.1156 5.98788H7.60813C7.06757 5.98788 6.55864 5.73485 6.23229 5.30499L1.22921 0H17.1571C17.1974 0 17.2376 0.00143767 17.2779 0.004313C17.2836 0.004313 17.2908 0.004313 17.298 0.00575067C17.9981 0.0632573 18.5991 0.539125 18.8076 1.21914L19.2432 2.64243C19.4114 3.18875 19.9146 3.56254 20.4868 3.56254H25.6854C26.4444 3.56254 27.1144 4.0571 27.3358 4.78312L28.6009 8.91497C28.9733 10.1327 28.7605 11.4539 28.023 12.4933Z',
      fill: 'url(#lgrad)',
    }),
  );

const PodioBrand = () =>
  React.createElement(
    Svg,
    { width: 60, height: 18, viewBox: '0 0 60 19' },
    React.createElement(Path, {
      d: 'M19.7389 5.00534C21.0148 5.00535 22.1414 5.29011 23.1078 5.8702C24.0692 6.44729 24.8164 7.24686 25.3468 8.26266C25.8783 9.273 26.1397 10.4298 26.1397 11.725C26.1397 13.0281 25.8745 14.1927 25.3352 15.2107L25.3351 15.2105C24.8044 16.2189 24.0573 17.0143 23.0965 17.5911L23.0949 17.592C22.129 18.1638 21.0069 18.4446 19.7389 18.4446C18.4701 18.4446 17.3473 18.1597 16.3811 17.5798C15.4201 17.0029 14.6728 16.2073 14.1421 15.1986L14.1415 15.1973L14.1408 15.1962C13.6178 14.1792 13.3605 13.0196 13.3605 11.725C13.3605 10.4076 13.6256 9.23867 14.1656 8.22726C14.7039 7.21913 15.4551 6.42731 16.4167 5.85801C17.3817 5.28666 18.4924 5.00534 19.7389 5.00534ZM39.2123 18.4576H36.2063V17.5318C35.3186 18.1512 34.2557 18.4446 33.0151 18.4446C31.8382 18.4446 30.7977 18.149 29.9052 17.549C29.0201 16.954 28.3367 16.1455 27.8548 15.1315C27.3729 14.1175 27.1351 12.9801 27.1351 11.725C27.1351 10.4555 27.3726 9.31384 27.8551 8.30648L27.8555 8.30561C28.3458 7.29072 29.0417 6.48574 29.9427 5.89864C30.8502 5.29985 31.9123 5.00534 33.1171 5.00534C34.1687 5.00534 35.0891 5.22715 35.8664 5.68202V0H39.2123V18.4576ZM53.3875 5.00534C54.6634 5.00534 55.7899 5.29011 56.7564 5.8702C57.7178 6.4473 58.4651 7.24684 58.9955 8.26266L59.0445 8.35784C59.5431 9.34546 59.7885 10.4703 59.7885 11.725C59.7885 13.0281 59.5231 14.1927 58.9838 15.2107L58.9836 15.2105C58.453 16.2189 57.7059 17.0143 56.745 17.5911L56.7436 17.592C55.7777 18.1638 54.6555 18.4446 53.3875 18.4446C52.1187 18.4446 50.996 18.1597 50.0299 17.5798C49.0688 17.0029 48.3213 16.2073 47.7907 15.1986L47.7901 15.1973L47.7895 15.1962C47.2666 14.1792 47.0091 13.0196 47.0091 11.725C47.0091 10.4076 47.2743 9.23868 47.8143 8.22726C48.3526 7.21913 49.1038 6.42731 50.0654 5.85801C51.0304 5.28668 52.141 5.00534 53.3875 5.00534ZM7.03517 0C7.20085 0 7.40944 0.00764142 7.65919 0.0226334C7.91622 0.0305294 8.15725 0.0540047 8.38166 0.0934353C9.36399 0.241995 10.1925 0.569408 10.8524 1.08771C11.5127 1.60048 12.0011 2.25094 12.315 3.03403L12.3728 3.17912C12.6528 3.90979 12.7905 5.99888 12.7906 6.86868C12.7906 7.78936 12.6337 8.63956 12.3154 9.41537L12.315 9.41638C11.9936 10.1918 11.5017 10.8377 10.8424 11.3501C10.1827 11.8687 9.35808 12.1967 8.38224 12.3455L8.3792 12.346C8.1584 12.3773 7.9162 12.4005 7.65311 12.4159C7.40137 12.4311 7.19467 12.4391 7.03517 12.4391H3.32309V18.4446H0V0H7.03517ZM45.1167 18.4446H41.7936V4.78252H45.1167V18.4446ZM33.5248 8.03343C32.8421 8.03343 32.3053 8.20072 31.8921 8.51395C31.4646 8.8314 31.1464 9.26313 30.9379 9.82306L30.9375 9.82422C30.7253 10.3871 30.6168 11.0195 30.6168 11.725C30.6168 12.4376 30.7214 13.0776 30.9262 13.6482L30.9665 13.7508C31.1746 14.2563 31.4732 14.6521 31.8594 14.9482C32.2574 15.2533 32.7748 15.4166 33.4341 15.4166C34.1231 15.4166 34.6439 15.2613 35.0239 14.9793C35.4226 14.6815 35.718 14.2649 35.9049 13.714L35.906 13.7108C36.0916 13.1833 36.193 12.57 36.205 11.8669L36.2063 11.725L36.205 11.5818C36.193 10.8722 36.0914 10.2598 35.9063 9.74022C35.7171 9.18246 35.4279 8.76983 35.0447 8.48058C34.6682 8.18999 34.1708 8.03343 33.5248 8.03343ZM19.7389 8.14616C19.051 8.14616 18.5104 8.30101 18.0962 8.58882C17.6815 8.87502 17.3692 9.27908 17.1619 9.81537L17.1615 9.81653C16.9512 10.3534 16.8422 10.9875 16.8422 11.725C16.8422 12.8604 17.1001 13.7332 17.5854 14.3728C18.0619 14.9838 18.7631 15.304 19.7389 15.304C20.7545 15.304 21.4628 14.9716 21.923 14.3436C22.4049 13.686 22.6582 12.8211 22.6582 11.725C22.6582 10.5891 22.4001 9.72061 21.9156 9.08907C21.4466 8.47157 20.7399 8.14617 19.7389 8.14616ZM53.3875 8.14616C52.6996 8.14616 52.1591 8.30102 51.7449 8.58882C51.3301 8.87502 51.0179 9.27908 50.8106 9.81537L50.81 9.81653C50.5998 10.3534 50.4908 10.9875 50.4908 11.725C50.4908 12.8603 50.7486 13.7331 51.2338 14.3727C51.7104 14.9838 52.4116 15.304 53.3875 15.304C54.4031 15.304 55.1113 14.9716 55.5715 14.3436C56.0535 13.686 56.3068 12.8211 56.3068 11.725C56.3068 10.589 56.0487 9.72061 55.5641 9.08907C55.0952 8.47156 54.3885 8.14616 53.3875 8.14616ZM3.32309 9.3096H6.92194C7.06339 9.3096 7.22519 9.30253 7.40793 9.28798C7.58 9.27429 7.73411 9.24719 7.87131 9.20819C8.28892 9.10422 8.58716 8.93066 8.79632 8.69807C9.03325 8.44191 9.19465 8.15911 9.28696 7.84424C9.39358 7.50431 9.44485 7.1813 9.44485 6.86868C9.44484 6.55606 9.39358 4.94596 9.28855 4.61155C9.19387 4.28194 9.03226 3.99598 8.79908 3.74408C8.58716 3.5083 8.28891 3.33488 7.88088 3.23338C7.73836 3.19312 7.58829 3.16972 7.41968 3.16301C7.22519 3.14774 7.06339 3.14082 6.92194 3.14082H3.32309V9.3096ZM21.0123 4.19127H18.2961L20.2887 0.0129956H23.0048L21.0123 4.19127ZM45.1167 3.15379H41.7936V0.0694119H45.1167V3.15379Z',
      fill: '#202020',
    }),
  );

const TicketBrand = () =>
  React.createElement(
    Svg,
    { width: 70, height: 18, viewBox: '0 0 70 19' },
    React.createElement(Path, {
      d: 'M5.96792 18.4138L6.06698 2.26953H0V0.0126195H14.3334V2.26953H8.26642L8.16736 18.4138H5.96792Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M16.3007 2.39514V0.0126195H18.5001V2.39514H16.3007ZM16.2017 18.4138L16.3007 4.74685H18.5001L18.4011 18.4138H16.2017Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M27.5826 18.4138C26.2317 18.4138 25.0825 18.1142 24.1352 17.515C23.1961 16.9076 22.4794 16.0744 21.9852 15.0155C21.4909 13.9567 21.2356 12.75 21.2191 11.3956C21.2356 10.0084 21.4951 8.78948 21.9975 7.7388C22.5083 6.67992 23.2373 5.85498 24.1846 5.26397C25.1319 4.67297 26.2729 4.37747 27.6073 4.37747C29.016 4.37747 30.2269 4.72222 31.2401 5.41173C32.2616 6.10123 32.9453 7.0452 33.2913 8.24362L31.1166 8.89619C30.8365 8.1246 30.3793 7.52539 29.745 7.09855C29.1189 6.67171 28.3982 6.4583 27.5826 6.4583C26.6683 6.4583 25.9145 6.67171 25.3214 7.09855C24.7283 7.51718 24.2876 8.09997 23.9993 8.84694C23.711 9.58569 23.5627 10.4353 23.5545 11.3956C23.5709 12.8732 23.9128 14.0675 24.58 14.9786C25.2555 15.8815 26.2564 16.333 27.5826 16.333C28.4558 16.333 29.1807 16.136 29.7574 15.742C30.334 15.3398 30.7706 14.7611 31.0671 14.0059L33.2913 14.5846C32.83 15.8241 32.1092 16.7721 31.1289 17.4288C30.1486 18.0855 28.9665 18.4138 27.5826 18.4138Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M35.5536 18.4138L35.566 0.0126195H37.7902V11.1494L43.3876 4.74685H46.2419L40.3479 11.3956L47.1471 18.4138H44.0704L37.7902 11.6419V18.4138H35.5536Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M53.458 18.4138C52.1483 18.4138 51.0032 18.1265 50.023 17.5519C49.0509 16.9691 48.2931 16.1606 47.7494 15.1264C47.2057 14.0839 46.9339 12.869 46.9339 11.4818C46.9339 10.0289 47.2016 8.77306 47.737 7.71418C48.2725 6.64709 49.018 5.82625 49.9735 5.25166C50.9373 4.66887 52.0659 4.37747 53.3592 4.37747C54.7019 4.37747 55.8428 4.68528 56.7819 5.30091C57.7292 5.91654 58.4377 6.79484 58.9072 7.93581C59.385 9.07677 59.5909 10.4353 59.525 12.0113H57.3009V11.2233C57.2762 9.5898 56.9426 8.37085 56.3 7.56643C55.6575 6.7538 54.7019 6.34748 53.4333 6.34748C52.0741 6.34748 51.0403 6.78253 50.3319 7.65262C49.6234 8.52271 49.2692 9.77038 49.2692 11.3956C49.2692 12.9634 49.6234 14.1783 50.3319 15.0402C51.0403 15.9021 52.0494 16.333 53.3592 16.333C54.2406 16.333 55.0067 16.1319 55.6575 15.742C56.3083 15.3275 56.819 14.7488 57.1897 13.9936L59.3026 14.72C58.7836 15.8938 58.0011 16.805 56.9549 17.4534C55.917 18.0937 54.7514 18.4138 53.458 18.4138ZM48.5278 12.0113V10.2506H58.3882V12.0113H48.5278Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M69.4798 18.1919C68.689 18.3479 67.9064 18.4094 67.1321 18.3766C66.366 18.352 65.6823 18.2001 65.081 17.921C64.4796 17.6337 64.0224 17.043 63.7094 16.4438C63.4458 15.9185 63.3016 15.389 63.2769 14.8555C63.2604 14.3137 63.2522 13.7022 63.2522 13.0209V0H65.4516V12.9224C65.4516 13.4642 65.4558 13.9279 65.464 14.3137C65.4805 14.6995 65.567 15.032 65.7235 15.311C66.02 15.8364 66.4896 16.1442 67.1321 16.2345C67.7829 16.3248 68.5655 16.3002 69.4798 16.1606V18.1919ZM60.5462 6.5568V4.74685H69.4798V6.5568H60.5462Z',
      fill: '#202020',
    }),
  );

/* Calcula altura aproximada para página única (scroll infinito) */
function estimatePageHeight(data: TicketPdfTemplateData): number {
  // Cabeçalho fixo: logo + HR + título seção + event card
  let h = 32 + 60 + 1 + 20 + 18 + 12 + 14 + 16; // header + section title
  h += 16 + 36 + 8 + 16 + 1 + 20; // event card: icon row + HR + gap
  h += (14 + 8 + 16) * 2 + 16; // 2 linhas de metadata
  h += 16; // card padding

  for (const reg of data.registrations) {
    h += 16; // marginTop do card

    // Cabeçalho do participante: QR 80px + padding
    h += 20 + 80 + 20;

    // Informações do participante
    const fieldCount = [reg.email, reg.cpf, reg.dateOfBirth, reg.phone, reg.gender]
      .filter(Boolean).length;
    if (fieldCount > 0) {
      h += 24 + 18 + 20; // padding + título + gap
      h += fieldCount * (8 + 16 + 12 + 16 + 8); // cada FieldItem
      h += 24;
    }

    // Perguntas
    if (reg.questionAnswers.length > 0) {
      h += 1 + 24 + 18 + 20; // HR + padding + título + gap
      h += reg.questionAnswers.length * (8 + 16 + 12 + 16 + 8);
      h += 24;
    }

    // Produtos
    if (reg.products.length > 0) {
      h += 1 + 24 + 18 + 20; // HR + padding + título + gap
      // Cada linha de produto: imagem 100 + padding top/bottom 32 + seção tamanho/badge ~90
      h += Math.ceil(reg.products.length / 2) * 280;
      h += 24;
    }
  }

  h += 32 + 500; // paddingBottom + buffer de segurança generoso
  return Math.max(842, h);
}

export const TicketPdfDocument = ({ data }: { data: TicketPdfTemplateData }) => {
  const pageHeight = estimatePageHeight(data);

  return React.createElement(
    Document,
    { title: `Ingresso — ${data.event.name}`, author: 'PódioTicket' },
    React.createElement(
      Page,
      {
        size: [595, pageHeight],
        style: {
          fontFamily: 'DM Sans',
          backgroundColor: C.white,
          paddingHorizontal: 52,
          paddingVertical: 32,
        },
      },
      /* Cabeçalho: logo + dados do pedido */
      React.createElement(
        View,
        {
          style: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          },
        },
        React.createElement(
          View,
          { style: { flexDirection: 'row', alignItems: 'center', gap: 6 } },
          React.createElement(LogoVector, null),
          React.createElement(PodioBrand, null),
          React.createElement(TicketBrand, null),
        ),
        React.createElement(
          View,
          { style: { alignItems: 'flex-end', gap: 12 } },
          React.createElement(
            View,
            { style: { flexDirection: 'row', gap: 4 } },
            React.createElement(
              Text,
              { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray12 } },
              'Pedido: ',
            ),
            React.createElement(
              Text,
              { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 600, color: C.gray12 } },
              data.orderId,
            ),
          ),
          React.createElement(
            Text,
            { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray11 } },
            `Emitido em ${fmtDateTime(data.issuedAt)}`,
          ),
        ),
      ),
      React.createElement(HR, null),
      /* Título da seção */
      React.createElement(
        View,
        { style: { gap: 12, marginTop: 20, marginBottom: 16 } },
        React.createElement(
          Text,
          { style: { fontFamily: 'Manrope', fontSize: 18, fontWeight: 800, color: C.gray12 } },
          'Detalhes da inscrição',
        ),
        React.createElement(
          Text,
          { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 400, color: C.gray11 } },
          'Apresente os QR Codes na retirada do kit ou na entrada do evento',
        ),
      ),
      /* Card resumo do evento */
      React.createElement(
        View,
        {
          style: {
            padding: 16,
            backgroundColor: C.gray2,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: C.gray6,
            borderStyle: 'solid',
            gap: 20,
            marginBottom: 0,
          },
        },
        React.createElement(
          View,
          { style: { flexDirection: 'row', alignItems: 'center', gap: 12 } },
          React.createElement(
            View,
            { style: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' } },
            React.createElement(
              Svg,
              { width: 27, height: 30, viewBox: '0 0 36 36' },
              React.createElement(Path, {
                d: 'M4.5 33V21M4.5 21V4.5M4.5 21H10.5M4.5 4.5V3M4.5 4.5H22.5C24.1569 4.5 25.5 5.84315 25.5 7.5V10.5M25.5 10.5H28.5C30.1569 10.5 31.5 11.8431 31.5 13.5V25.5C31.5 27.1569 30.1569 28.5 28.5 28.5H13.5C11.8431 28.5 10.5 27.1569 10.5 25.5V21M25.5 10.5V18C25.5 19.6569 24.1569 21 22.5 21H10.5',
                stroke: C.gray12,
                strokeWidth: 2,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                fill: 'none',
              }),
            ),
          ),
          React.createElement(
            View,
            { style: { gap: 8 } },
            React.createElement(
              Text,
              { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 400, color: C.gray11 } },
              'Evento',
            ),
            React.createElement(
              Text,
              { style: { fontFamily: 'Manrope', fontSize: 16, fontWeight: 700, color: C.gray12 } },
              data.event.name,
            ),
          ),
        ),
        React.createElement(HR, null),
        /* Duas linhas de 2 colunas evita bug de altura no yoga-layout com texto longo */
        React.createElement(
          View,
          { style: { gap: 16 } },
          /* Linha 1: Data + Organização */
          React.createElement(
            View,
            { style: { flexDirection: 'row', gap: 12 } },
            ...[
              { label: 'Data', value: fmtDate(data.event.date) },
              { label: 'Organização', value: data.event.organization },
            ].map(({ label, value }) =>
              React.createElement(
                View,
                { key: label, style: { flex: 1, minWidth: 0, gap: 8 } },
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 400, color: C.gray11 } },
                  label,
                ),
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 16, fontWeight: 500, color: C.gray12 } },
                  value,
                ),
              ),
            ),
          ),
          /* Linha 2: Local + Participantes */
          React.createElement(
            View,
            { style: { flexDirection: 'row', gap: 12 } },
            ...[
              { label: 'Local', value: data.event.location },
              {
                label: 'Participantes',
                value: `${data.event.participantCount} atleta${data.event.participantCount !== 1 ? 's' : ''}`,
              },
            ].map(({ label, value }) =>
              React.createElement(
                View,
                { key: label, style: { flex: 1, minWidth: 0, gap: 8 } },
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 400, color: C.gray11 } },
                  label,
                ),
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 16, fontWeight: 500, color: C.gray12 } },
                  value,
                ),
              ),
            ),
          ),
        ),
      ),
      /* Cards de participantes */
      ...data.registrations.map((reg) =>
        React.createElement(ParticipantCard, { key: reg.index, reg }),
      ),
    ),
  );
};
