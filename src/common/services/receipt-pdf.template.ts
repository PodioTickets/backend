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
  Rect,
  Circle,
} from '@react-pdf/renderer';
import * as path from 'path';
import { ReceiptPdfData } from './receipt-pdf.types';

const LinearGradient = LinearGradientBase as any;

/**
 * Decide se o comprador é brasileiro com base no campo `country` do User.
 * Aceita variantes ("BR", "Brasil", "Brazil"). null/undefined → BR (default).
 */
function isBR(country?: string | null): boolean {
  if (!country) return true;
  const c = country.trim().toLowerCase();
  return c === 'br' || c === 'brasil' || c === 'brazil';
}

function fmtCPF(cpf: string): string {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/**
 * Prefixo "#" SOMENTE de exibição para qualquer ID mostrado no recibo
 * (pedido, inscrição, transação). Não altera o valor persistido/snapshot nem
 * nada usado em busca/comparação — é puramente cosmético, alinhado ao padrão
 * visual do frontend (`#{orderId}` / `#{registrationId}` no modal de pedido).
 */
const idTag = (v: string): string => `#${v}`;

function formatPaymentMethod(method: string | undefined): string {
  const m = (method ?? '').toUpperCase();
  if (m === 'CREDIT_CARD') return 'Cartão de crédito';
  if (m === 'DEBIT_CARD') return 'Cartão de débito';
  if (m.includes('PIX')) return 'Pix';
  if (m === 'BOLETO') return 'Boleto';
  if (m === 'FREE') return 'Gratuito';
  return method || '—';
}

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
  gray3: '#F0F0F0',
  gray2: '#F9F9F9',
  white: '#FFFFFF',
  green11: '#21835D',
  green12: '#193B30',
  green3: '#DAF1DB',
  green8: '#46A758',
  greenPrimary: '#308737',
  greenPrimaryText: '#F5FBF5',
  amber12: '#4F3422',
  pixColor: '#62B7AF',
} as const;

// Fuso de Brasília (UTC-3 fixo desde 2019). Usado para INSTANTES REAIS
// (pagamento/emissão). O servidor roda em UTC em produção, então `getHours()`
// cravaria UTC — por isso formatamos explicitamente no fuso de Brasília.
const TZ_BR = 'America/Sao_Paulo';

/** Componentes de data+hora de um INSTANTE REAL no fuso de Brasília. */
function brDateTimeParts(d: Date): { date: string; hh: string; mm: string } {
  const date = d.toLocaleDateString('pt-BR', { timeZone: TZ_BR });
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_BR,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return { date, hh, mm };
}

function fmtDateTime(d: Date): string {
  const { date, hh, mm } = brDateTimeParts(d);
  return `${date} · ${hh}h${mm}`;
}

function fmtDateTimeLong(d: Date): string {
  const { date, hh, mm } = brDateTimeParts(d);
  return `${date} - ${hh}:${mm}`;
}

function fmtCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Data-só (sem hora), para data de nascimento. Formata em UTC porque o valor é
 * armazenado à meia-noite UTC — formatar no fuso BR (UTC-3) voltaria 1 dia.
 */
function fmtDateOnly(d: Date | string): string {
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

const HR = () =>
  React.createElement(View, { style: { height: 1, backgroundColor: C.gray6 } });

const SectionBadge = ({ number, title }: { number: string; title: string }) =>
  React.createElement(
    View,
    { style: { flexDirection: 'row', alignItems: 'center', gap: 8 } },
    React.createElement(
      View,
      {
        style: {
          width: 24,
          height: 24,
          backgroundColor: C.greenPrimary,
          borderRadius: 4,
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
      React.createElement(
        Text,
        {
          style: {
            fontFamily: 'Manrope',
            fontSize: 12,
            fontWeight: 800,
            color: C.greenPrimaryText,
          },
        },
        number,
      ),
    ),
    React.createElement(
      Text,
      { style: { fontFamily: 'DM Sans', fontSize: 13, fontWeight: 700, color: C.gray12 } },
      title,
    ),
  );

const TxField = ({
  label,
  value,
  amber,
}: {
  label: string;
  value: string;
  amber?: boolean;
}) =>
  React.createElement(
    View,
    { style: { paddingVertical: 10, gap: 8 } },
    React.createElement(
      Text,
      { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray12 } },
      label,
    ),
    amber
      ? React.createElement(
        View,
        { style: { flexDirection: 'row', alignItems: 'center', gap: 4 } },
        React.createElement(
          Svg,
          { width: 14, height: 14, viewBox: '0 0 16 16' },
          React.createElement(Rect, {
            x: 1.33,
            y: 1.33,
            width: 13.33,
            height: 13.33,
            rx: 2,
            stroke: C.amber12,
            strokeWidth: 1.5,
            fill: 'none',
          }),
        ),
        React.createElement(
          Text,
          {
            style: { fontFamily: 'DM Sans', fontSize: 12, fontWeight: 700, color: C.amber12 },
          },
          value,
        ),
      )
      : React.createElement(
        Text,
        { style: { fontFamily: 'DM Sans', fontSize: 12, fontWeight: 700, color: C.gray12 } },
        value || '—',
      ),
  );

const InfoRow = ({ label, value }: { label: string; value: string }) =>
  React.createElement(
    View,
    { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
    React.createElement(
      Text,
      { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray11, flexShrink: 0 } },
      label,
    ),
    React.createElement(
      Text,
      { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 500, color: C.gray12, flex: 1, textAlign: 'right' } },
      value,
    ),
  );

const FinancialRow = ({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) =>
  React.createElement(
    View,
    { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
    React.createElement(
      Text,
      {
        style: {
          fontFamily: bold ? 'Manrope' : 'DM Sans',
          fontSize: bold ? 13 : 11,
          fontWeight: bold ? 800 : 400,
          color: C.gray12,
        },
      },
      label,
    ),
    React.createElement(
      Text,
      {
        style: {
          fontFamily: bold ? 'Manrope' : 'DM Sans',
          fontSize: bold ? 13 : 11,
          fontWeight: bold ? 800 : 600,
          color: C.gray12,
        },
      },
      value,
    ),
  );

export const ReceiptPdfDocument = ({ data }: { data: ReceiptPdfData }) => {
  // Pedido sem custo (R$ 0,00): detectado pelo TOTAL, não pelo método salvo.
  // O schema não tem método "FREE" — pedidos grátis gravam o método selecionado
  // no checkout (ex.: PIX). Nesses pedidos a barra de forma de pagamento é
  // OMITIDA (mesma regra do modal de pedido), então não exibimos método/ícone.
  const isFree = (data.financial?.total ?? 0) <= 0;
  const isPix = !!data.payment.method?.toLowerCase().includes('pix');

  const declarationText =
    `O pagamento referente ao pedido ${idTag(data.orderNumber)} foi recebido e processado com sucesso` +
    (data.payment.gateway ? ` pelo gateway ${data.payment.gateway}` : '') +
    ` em ${fmtDateTimeLong(data.payment.paidAt)}. Este recibo é o comprovante oficial da transação.` +
    ` Para detalhes dos participantes (QR Code, dados pessoais e perguntas do organizador), consulte o PDF de ingressos enviado junto com este documento.`;

  return React.createElement(
    Document,
    { title: `Recibo — ${data.orderNumber}`, author: 'PódioTicket' },
    React.createElement(
      Page,
      {
        size: 'A4',
        // Sem a seção de ingressos, o conteúdo é fixo e curto: `wrap={false}`
        // impede que o react-pdf abra uma 2ª página (documento contínuo, sem
        // corte entre seções).
        wrap: false,
        style: {
          fontFamily: 'DM Sans',
          backgroundColor: C.white,
          paddingHorizontal: 48,
          paddingVertical: 28,
        },
      },
      // header
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
        React.createElement(Image, {
          src: path.join(__dirname, '..', 'assets', 'logo-podioticket.png'),
          style: { width: 160, height: 27 },
        }),
        React.createElement(
          View,
          { style: { alignItems: 'flex-end', gap: 6 } },
          React.createElement(
            View,
            { style: { flexDirection: 'row', gap: 4 } },
            React.createElement(
              Text,
              {
                style: {
                  fontFamily: 'DM Sans',
                  fontSize: 11,
                  fontWeight: 400,
                  color: C.gray12,
                },
              },
              'Pedido: ',
            ),
            React.createElement(
              Text,
              {
                style: {
                  fontFamily: 'DM Sans',
                  fontSize: 11,
                  fontWeight: 600,
                  color: C.gray12,
                },
              },
              idTag(data.orderNumber),
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
      // title
      React.createElement(
        View,
        { style: { marginTop: 20, marginBottom: 18 } },
        React.createElement(
          Text,
          { style: { fontFamily: 'Manrope', fontSize: 15, fontWeight: 800, color: C.gray12 } },
          'Recibo de pagamento',
        ),
      ),
      // info cards row
      React.createElement(
        View,
        { style: { flexDirection: 'row', gap: 16, marginBottom: 20 } },
        // organization card
        React.createElement(
          View,
          {
            style: {
              flex: 1,
              padding: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: C.gray6,
              borderStyle: 'solid',
              gap: 14,
            },
          },
          React.createElement(
            View,
            { style: { flexDirection: 'row', alignItems: 'center', gap: 8 } },
            data.organization.logoUrl
              ? React.createElement(Image, {
                src: data.organization.logoUrl,
                style: { width: 36, height: 36, borderRadius: 124, objectFit: 'cover' },
              })
              : React.createElement(
                View,
                {
                  style: {
                    width: 36,
                    height: 36,
                    backgroundColor: C.green12,
                    borderRadius: 124,
                    borderWidth: 1,
                    borderColor: C.green8,
                    borderStyle: 'solid',
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                },
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 700, color: C.white } },
                  (data.organization.name || '?')[0].toUpperCase(),
                ),
              ),
            React.createElement(
              Text,
              {
                style: {
                  fontFamily: 'Manrope',
                  fontSize: 13,
                  fontWeight: 700,
                  color: C.gray12,
                  flex: 1,
                },
              },
              data.organization.name,
            ),
          ),
          React.createElement(
            View,
            { style: { gap: 10 } },
            data.organization.document
              ? React.createElement(InfoRow, { label: 'CNPJ', value: data.organization.document })
              : null,
            React.createElement(InfoRow, { label: 'Evento', value: data.event.name }),
          ),
        ),
        // buyer card
        React.createElement(
          View,
          {
            style: {
              flex: 1,
              padding: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: C.gray6,
              borderStyle: 'solid',
              gap: 14,
            },
          },
          // Cabeçalho do card: avatar do comprador (ou inicial) + nome — espelha o card da organização.
          React.createElement(
            View,
            { style: { flexDirection: 'row', alignItems: 'center', gap: 8 } },
            data.buyer.imageUrl
              ? React.createElement(Image, {
                src: data.buyer.imageUrl,
                style: { width: 36, height: 36, borderRadius: 124, objectFit: 'cover' },
              })
              : React.createElement(
                View,
                {
                  style: {
                    width: 36,
                    height: 36,
                    backgroundColor: C.green12,
                    borderRadius: 124,
                    borderWidth: 1,
                    borderColor: C.green8,
                    borderStyle: 'solid',
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                },
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 14, fontWeight: 700, color: C.white } },
                  (data.buyer.name || '?')[0].toUpperCase(),
                ),
              ),
            React.createElement(
              Text,
              { style: { fontFamily: 'Manrope', fontSize: 13, fontWeight: 700, color: C.gray12, flex: 1 } },
              data.buyer.name,
            ),
          ),
          React.createElement(
            View,
            { style: { gap: 10 } },
            data.buyer.document
              ? React.createElement(InfoRow, {
                label: 'Documento',
                value: isBR(data.buyer.country)
                  ? fmtCPF(data.buyer.document)
                  : data.buyer.document,
              })
              : null,
            data.buyer.birthDate
              ? React.createElement(InfoRow, {
                label: 'Data de nascimento',
                value: fmtDateOnly(data.buyer.birthDate),
              })
              : null,
          ),
        ),
      ),
      // payment method bar — OMITIDA em pedido gratuito (mesma regra do modal de pedido)
      isFree
        ? null
        : React.createElement(
          View,
          {
            style: {
              padding: 12,
              backgroundColor: C.gray2,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: C.gray6,
              borderStyle: 'solid',
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 20,
            },
          },
          React.createElement(
            View,
            { style: { flexDirection: 'row', alignItems: 'center', gap: 12 } },
            React.createElement(
              View,
              {
                style: {
                  height: 32,
                  width: 48,
                  padding: 4,
                  backgroundColor: C.white,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: C.gray6,
                  borderStyle: 'solid',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              },
              isPix
                ? React.createElement(
                  Svg,
                  { width: 22, height: 22, viewBox: '0 0 20 20' },
                  // Logo oficial do Pix (mesmo SVG do frontend, `PixIcon.tsx`).
                  React.createElement(Path, {
                    d: 'M15.5961 15.2993C15.2102 15.3001 14.828 15.2246 14.4715 15.077C14.1149 14.9294 13.7912 14.7126 13.5188 14.4393L10.5186 11.4393C10.4124 11.3384 10.2715 11.2821 10.125 11.2821C9.97852 11.2821 9.83762 11.3384 9.73141 11.4393L6.71977 14.4507C6.44752 14.7242 6.12376 14.941 5.76721 15.0886C5.41066 15.2362 5.02838 15.3117 4.64248 15.3107H4.051L7.85128 19.1107C9.03708 20.2964 10.9615 20.2964 12.1473 19.1107L15.9576 15.2993H15.5961ZM4.64248 4.68782C5.42825 4.68782 6.16544 4.99354 6.71977 5.54782L9.73141 8.55926C9.78316 8.61109 9.84463 8.65221 9.91229 8.68027C9.97995 8.70833 10.0525 8.72277 10.1257 8.72277C10.199 8.72277 10.2715 8.70833 10.3392 8.68027C10.4068 8.65221 10.4683 8.61109 10.52 8.55926L13.5203 5.55925C13.7923 5.28594 14.1159 5.06922 14.4721 4.92161C14.8284 4.774 15.2105 4.69843 15.5961 4.69925H15.9576L12.1473 0.889242C11.5775 0.319849 10.8049 0 9.99929 0C9.19371 0 8.4211 0.319849 7.85128 0.889242L4.051 4.68925L4.64248 4.68782Z',
                    fill: C.pixColor,
                  }),
                  React.createElement(Path, {
                    d: 'M19.1107 7.85069L16.8076 5.54782C16.7559 5.56905 16.7006 5.5802 16.6448 5.58068H15.5975C15.0561 5.58068 14.526 5.80068 14.1446 6.18354L11.1444 9.18355C11.0109 9.31766 10.8523 9.42409 10.6776 9.49671C10.5029 9.56933 10.3156 9.60672 10.1264 9.60672C9.93725 9.60672 9.74993 9.56933 9.57524 9.49671C9.40055 9.42409 9.24193 9.31766 9.10851 9.18355L6.09686 6.17068C5.71048 5.78591 5.18778 5.56925 4.64247 5.56782H3.35667C3.30336 5.5674 3.25059 5.55723 3.20094 5.53782L0.889349 7.85069C-0.29645 9.0364 -0.29645 10.9607 0.889349 12.1478L3.20094 14.4593C3.25004 14.4395 3.30233 14.4289 3.35524 14.4278H4.64247C5.18537 14.4278 5.71398 14.2093 6.09686 13.8264L9.10708 10.8135C9.38175 10.5521 9.74647 10.4062 10.1257 10.4062C10.505 10.4062 10.8697 10.5521 11.1444 10.8135L14.1446 13.8136C14.526 14.1964 15.0561 14.415 15.5975 14.415H16.6448C16.7019 14.415 16.7576 14.4293 16.8076 14.4493L19.1107 12.1464C20.2964 10.9607 20.2964 9.0364 19.1107 7.85069Z',
                    fill: C.pixColor,
                  }),
                )
                : data.payment.iconDataUri
                  ? React.createElement(Image, {
                    src: data.payment.iconDataUri,
                    style: { width: 40, height: 26, objectFit: 'contain' },
                  })
                  : React.createElement(
                    Svg,
                    { width: 20, height: 20, viewBox: '0 0 24 24' },
                    React.createElement(Rect, {
                      x: 2, y: 5, width: 20, height: 14, rx: 2,
                      stroke: C.gray12, strokeWidth: 1.5, fill: 'none',
                    }),
                    React.createElement(Path, {
                      d: 'M2 10H22',
                      stroke: C.gray12, strokeWidth: 1.5,
                    }),
                    React.createElement(Path, {
                      d: 'M6 15H10',
                      stroke: C.gray12, strokeWidth: 1.5, strokeLinecap: 'round',
                    }),
                  ),
            ),
            React.createElement(
              View,
              { style: { gap: 6 } },
              React.createElement(
                Text,
                {
                  style: {
                    fontFamily: 'DM Sans',
                    fontSize: 13,
                    fontWeight: 600,
                    color: C.gray12,
                  },
                },
                formatPaymentMethod(data.payment.method),
              ),
              React.createElement(
                Text,
                {
                  style: {
                    fontFamily: 'DM Sans',
                    fontSize: 11,
                    fontWeight: 400,
                    color: C.gray12,
                  },
                },
                'Pagamento instantâneo',
              ),
            ),
          ),
          // "Pago" badge
          React.createElement(
            View,
            {
              style: {
                paddingHorizontal: 12,
                paddingVertical: 6,
                backgroundColor: C.green11,
                borderRadius: 4,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              },
            },
            React.createElement(
              Svg,
              { width: 14, height: 14, viewBox: '0 0 20 20' },
              React.createElement(Path, {
                d: 'M6.66663 9.99996L8.77886 11.901C9.13845 12.2246 9.69712 12.175 9.99412 11.7932L13.3333 7.49996M9.99996 18.3333C14.6023 18.3333 18.3333 14.6023 18.3333 9.99996C18.3333 5.39759 14.6023 1.66663 9.99996 1.66663C5.39759 1.66663 1.66663 5.39759 1.66663 9.99996C1.66663 14.6023 5.39759 18.3333 9.99996 18.3333Z',
                stroke: '#FBFEFB',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
            React.createElement(
              Text,
              { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: '#FBFEFB' } },
              'Pago',
            ),
          ),
        ),
      // Section 1: financial summary
      React.createElement(
        View,
        { style: { gap: 12, marginBottom: 20 } },
        React.createElement(SectionBadge, { number: '1', title: 'Resumo financeiro' }),
        React.createElement(
          View,
          {
            style: {
              padding: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: C.gray6,
              borderStyle: 'solid',
              gap: 14,
            },
          },
          // Itemização: por participante, a linha do ingresso (categoria - nome) com seu
          // preço e, abaixo, os produtos adicionais (mesmo grátis: incluso → "Incluso").
          ...data.registrations.flatMap((reg) => {
            const lines: any[] = [
              // Linha do ingresso: coluna esquerda com a CATEGORIA por cima e o NOME
              // embaixo (mesma View), e o preço à direita na mesma linha.
              React.createElement(
                View,
                {
                  key: `tk-${reg.id}`,
                  style: {
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                  },
                },
                React.createElement(
                  View,
                  { style: { flex: 1, gap: 2 } },
                  React.createElement(
                    Text,
                    { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray11 } },
                    reg.ticketCategory ?? "Ingresso avulso",
                  ),
                  React.createElement(
                    Text,
                    {
                      style: {
                        fontFamily: 'DM Sans',
                        fontSize: 11,
                        fontWeight: 600,
                        color: C.gray12,
                      },
                    },
                    reg.ticketName,
                  ),
                ),
                React.createElement(
                  Text,
                  { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray12 } },
                  fmtCurrency(reg.price),
                ),
              ),
            ];
            reg.products.forEach((p, pi) => {
              const label = p.variationName ? `${p.name} (${p.variationName})` : p.name;
              lines.push(
                React.createElement(
                  View,
                  {
                    key: `pr-${reg.id}-${pi}`,
                    style: {
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    },
                  },
                  React.createElement(
                    Text,
                    { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray11 } },
                    label,
                  ),
                  React.createElement(
                    Text,
                    { style: { fontFamily: 'DM Sans', fontSize: 11, fontWeight: 400, color: C.gray12 } },
                    p.isIncluded ? 'Incluso' : fmtCurrency(p.price),
                  ),
                ),
              );
            });
            return lines;
          }),
          React.createElement(HR, { key: 'items-hr' }),
          // Resumo igual ao do checkout (OrderSummary): Subtotal → desconto
          // (cupom/voucher) → taxa de serviço (só quando > 0) → Total, com um
          // único divisor antes do Total.
          React.createElement(FinancialRow, {
            label: 'Subtotal',
            value: fmtCurrency(data.financial.subtotal),
          }),
          ...(data.financial.discount > 0
            ? [
              React.createElement(FinancialRow, {
                label: data.financial.discountLabel || 'Desconto',
                value: `- ${fmtCurrency(data.financial.discount)}`,
              }),
            ]
            : []),
          ...(data.financial.serviceFee > 0
            ? [
              React.createElement(FinancialRow, {
                label: 'Taxa de serviço',
                value: fmtCurrency(data.financial.serviceFee),
              }),
            ]
            : []),
          React.createElement(HR, null),
          React.createElement(FinancialRow, {
            label: 'Total',
            value: fmtCurrency(data.financial.total),
            bold: true,
          }),
        ),
      ),
      // Section 2: transaction details
      React.createElement(
        View,
        { style: { gap: 12, marginBottom: 20 } },
        React.createElement(SectionBadge, { number: '2', title: 'Detalhes da transação' }),
        React.createElement(
          View,
          {
            style: {
              padding: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: C.gray6,
              borderStyle: 'solid',
            },
          },
          React.createElement(TxField, {
            label: 'Data da compra',
            value: fmtDateTimeLong(data.payment.paidAt),
          }),
          data.payment.gateway
            ? React.createElement(TxField, { label: 'Gateway', value: data.payment.gateway })
            : null,
          data.payment.voucherCode
            ? React.createElement(TxField, {
              label: 'Voucher utilizado',
              value: data.payment.voucherCode,
              amber: true,
            })
            : null,
          data.payment.txId
            ? React.createElement(TxField, { label: 'TxID', value: idTag(data.payment.txId) })
            : null,
          data.payment.transactionId
            ? React.createElement(TxField, {
              label: 'ID da transação',
              value: idTag(data.payment.transactionId),
            })
            : null,
          data.payment.e2eId
            ? React.createElement(TxField, { label: 'E2E ID (Pix)', value: idTag(data.payment.e2eId) })
            : null,
        ),
      ),
      // declaration
      React.createElement(
        View,
        {
          style: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            marginBottom: 20,
          },
        },
        React.createElement(
          Svg,
          { width: 18, height: 18, viewBox: '0 0 24 24', style: { marginTop: 1 } },
          React.createElement(Circle, { cx: 12, cy: 7, r: 1, fill: C.amber12 }),
          React.createElement(Path, {
            d: 'M11 10H12V17M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z',
            stroke: C.amber12,
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
        React.createElement(
          View,
          { style: { flex: 1 } },
          React.createElement(
            Text,
            { style: { fontFamily: 'DM Sans', fontSize: 10, fontWeight: 400, color: C.amber12 } },
            React.createElement(
              Text,
              { style: { fontWeight: 700 } },
              'Declaração: ',
            ),
            declarationText,
          ),
        ),
      ),
    ),
  );
};
