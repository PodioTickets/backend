export interface ReceiptPdfProductRow {
  name: string;
  variationName?: string;
  /** Preço pago pela linha do produto (centavos). 0 para produto incluso. */
  price: number;
  /** Produto incluso no ingresso (não cobrado à parte) → exibe "Incluso". */
  isIncluded: boolean;
}

export interface ReceiptPdfRegistrationRow {
  id: string;
  participantName: string;
  email?: string;
  ticketCategory?: string;
  ticketName: string;
  price: number;
  /** Produtos adicionais do participante (exibidos no resumo financeiro). */
  products: ReceiptPdfProductRow[];
}

export interface ReceiptPdfData {
  orderNumber: string;
  issuedAt: Date;
  organization: {
    name: string;
    document?: string;
    logoUrl?: string;
  };
  buyer: {
    name: string;
    document?: string;
    /**
     * País do comprador. Quando diferente de Brasil, o label muda de "CPF / CNPJ"
     * para "Documento" e o valor é exibido sem formatação de CPF.
     */
    country?: string | null;
    /** URL do avatar do comprador (exibida no card do comprador). */
    imageUrl?: string;
    /** Data de nascimento do comprador (exibida no lugar do "Evento" no card). */
    birthDate?: Date | string | null;
  };
  event: {
    name: string;
    date: Date | string;
    location: string;
  };
  payment: {
    method: string;
    paidAt: Date;
    /**
     * Status atual do pagamento (`PaymentStatus`: PAID/REFUNDED/CANCELLED/…).
     * Dirige o selo do recibo: o comprovante é gerado AO VIVO a partir do pedido,
     * então após um estorno o selo verde "Pago" deve virar "Estornado".
     */
    status?: string;
    /**
     * Instante do estorno, quando houver (`payment.metadata.refundedAt`). Exibido
     * no texto da declaração de um comprovante estornado.
     */
    refundedAt?: Date | string | null;
    gateway?: string;
    transactionId?: string;
    txId?: string;
    e2eId?: string;
    voucherCode?: string;
    couponCode?: string;
    cardBrand?: string;
    iconDataUri?: string;
  };
  financial: {
    subtotal: number;
    discount: number;
    /**
     * Rótulo da linha de desconto, já formatado como no resumo do checkout
     * (ex.: "Cupom ABC (10% OFF)", "Cupom automático", "Voucher XYZ"). Só
     * presente quando há desconto (> 0). Cupom e voucher são exclusivos.
     */
    discountLabel?: string;
    serviceFee: number;
    total: number;
  };
  registrations: ReceiptPdfRegistrationRow[];
}
