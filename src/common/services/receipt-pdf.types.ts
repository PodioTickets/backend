export interface ReceiptPdfRegistrationRow {
  id: string;
  participantName: string;
  email?: string;
  ticketCategory?: string;
  ticketName: string;
  price: number;
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
  };
  event: {
    name: string;
    date: Date | string;
    location: string;
  };
  payment: {
    method: string;
    paidAt: Date;
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
    voucherCode?: string;
    voucherPercent?: number;
    serviceFee: number;
    total: number;
  };
  registrations: ReceiptPdfRegistrationRow[];
}
