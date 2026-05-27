import type { ProductLocale } from "./types";

export interface PaidPrivateFileCopy {
  shell: {
    eyebrow: string;
    title: string;
    body: string;
    backLabel: string;
  };
  tabs: {
    send: string;
    receive: string;
  };
  send: {
    title: string;
    body: string;
    fileLabel: string;
    chooseFileLabel: string;
    emptyFileLabel: string;
    priceLabel: string;
    priceHint: string;
    payoutAddressLabel: string;
    payoutAddressPlaceholder: string;
    payoutAddressHint: string;
    noteLabel: string;
    notePlaceholder: string;
    submitLabel: string;
    busyLabel: string;
    successTitle: string;
    successBody: string;
    copyLinkLabel: string;
    openLinkLabel: string;
  };
  receive: {
    title: string;
    body: string;
    orderLabel: string;
    orderPlaceholder: string;
    loadLabel: string;
    payLabel: string;
    checkoutLabel: string;
    devPayLabel: string;
    unlockLabel: string;
    downloadLabel: string;
    paidStatus: string;
    pendingStatus: string;
  };
  details: {
    price: string;
    sellerPayoutAddress: string;
    file: string;
    size: string;
    status: string;
    digest: string;
    timestamp: string;
    paymentAddress: string;
    paymentMemo: string;
    invoice: string;
  };
  errors: {
    missingFile: string;
    invalidPrice: string;
    invalidPayoutAddress: string;
    missingOrder: string;
    serverError: string;
    paymentRequired: string;
  };
}

const COPY: Record<ProductLocale, PaidPrivateFileCopy> = {
  pt: {
    shell: {
      eyebrow: "Paid Private File",
      title: "Envie um arquivo privado. A pessoa paga em ZEC. Depois baixa e abre localmente.",
      body: "O arquivo e cifrado no browser antes do upload. CipherPay confirma o pagamento shielded e a API libera a chave apenas para o comprador que iniciou o checkout.",
      backLabel: "Paid Private File",
    },
    tabs: {
      send: "Enviar arquivo",
      receive: "Abrir link",
    },
    send: {
      title: "Criar arquivo privado pago",
      body: "Escolha o arquivo, defina o preco em ZEC e compartilhe acesso privado. O servidor guarda ciphertext; o comprador abre localmente depois do pagamento.",
      fileLabel: "Arquivo privado",
      chooseFileLabel: "Escolher arquivo",
      emptyFileLabel: "Nenhum arquivo selecionado",
      priceLabel: "Preco em ZEC",
      priceHint: "Exemplo: 0.05 ZEC. O valor e convertido para zatoshis.",
      payoutAddressLabel: "Wallet para receber ZEC",
      payoutAddressPlaceholder: "u1...",
      payoutAddressHint:
        "O pagamento do buyer deve ir para esta Unified Address.",
      noteLabel: "Nota para o comprador",
      notePlaceholder: "Opcional",
      submitLabel: "Criar arquivo privado pago",
      busyLabel: "Cifrando e criando link...",
      successTitle: "Arquivo privado pronto",
      successBody: "Compartilhe o link de acesso. O arquivo so abre depois que o pagamento em ZEC for confirmado.",
      copyLinkLabel: "Copiar link",
      openLinkLabel: "Abrir link",
    },
    receive: {
      title: "Pagar e abrir localmente",
      body: "Carregue o link, pague o invoice em ZEC e clique para baixar. A chave chega pela API, embrulhada para este browser.",
      orderLabel: "Paid Private File",
      orderPlaceholder: "Cole o link do arquivo ou order id",
      loadLabel: "Carregar",
      payLabel: "Criar pagamento",
      checkoutLabel: "Abrir checkout CipherPay",
      devPayLabel: "Confirmar pagamento dev",
      unlockLabel: "Baixar e abrir",
      downloadLabel: "Salvar arquivo aberto",
      paidStatus: "Pagamento confirmado",
      pendingStatus: "Aguardando pagamento",
    },
    details: {
      price: "Preco",
      sellerPayoutAddress: "Recebe ZEC",
      file: "Arquivo",
      size: "Tamanho",
      status: "Status",
      digest: "Ciphertext SHA-256",
      timestamp: "ZK timestamp commitment",
      paymentAddress: "Endereco de pagamento",
      paymentMemo: "Memo",
      invoice: "Invoice",
    },
    errors: {
      missingFile: "Escolha um arquivo antes de criar o link.",
      invalidPrice: "Informe um preco valido em ZEC.",
      invalidPayoutAddress: "Informe uma Unified Address Zcash valida para receber.",
      missingOrder: "Cole um link ou order id valido.",
      serverError: "Falha no paid link: ",
      paymentRequired: "Pagamento ainda nao confirmado. Aguarde o webhook ou tente novamente depois do checkout.",
    },
  },
  en: {
    shell: {
      eyebrow: "Paid Private File",
      title: "Send a private file. The recipient pays in ZEC. Then they download and open it locally.",
      body: "The browser encrypts the file before upload. CipherPay confirms the shielded payment and the API releases the key only to the buyer that started checkout.",
      backLabel: "Paid Private File",
    },
    tabs: {
      send: "Send file",
      receive: "Open link",
    },
    send: {
      title: "Create paid private file",
      body: "Pick a file, set the ZEC price, and share private access. The server stores ciphertext; the buyer opens it locally after payment.",
      fileLabel: "Private file",
      chooseFileLabel: "Choose file",
      emptyFileLabel: "No file selected",
      priceLabel: "Price in ZEC",
      priceHint: "Example: 0.05 ZEC. The value is converted to zatoshis.",
      payoutAddressLabel: "Wallet to receive ZEC",
      payoutAddressPlaceholder: "u1...",
      payoutAddressHint:
        "The buyer payment should go to this Unified Address.",
      noteLabel: "Note for buyer",
      notePlaceholder: "Optional",
      submitLabel: "Create paid private file",
      busyLabel: "Encrypting and creating link...",
      successTitle: "Private file ready",
      successBody: "Share the access link. The file opens only after the ZEC payment is confirmed.",
      copyLinkLabel: "Copy link",
      openLinkLabel: "Open link",
    },
    receive: {
      title: "Pay and open locally",
      body: "Load the link, pay the ZEC invoice, and unlock the download. The key is returned by API, wrapped for this browser.",
      orderLabel: "Paid Private File",
      orderPlaceholder: "Paste file link or order id",
      loadLabel: "Load",
      payLabel: "Create payment",
      checkoutLabel: "Open CipherPay checkout",
      devPayLabel: "Confirm dev payment",
      unlockLabel: "Download and open",
      downloadLabel: "Save opened file",
      paidStatus: "Payment confirmed",
      pendingStatus: "Waiting for payment",
    },
    details: {
      price: "Price",
      sellerPayoutAddress: "Receives ZEC",
      file: "File",
      size: "Size",
      status: "Status",
      digest: "Ciphertext SHA-256",
      timestamp: "ZK timestamp commitment",
      paymentAddress: "Payment address",
      paymentMemo: "Memo",
      invoice: "Invoice",
    },
    errors: {
      missingFile: "Choose a file before creating the link.",
      invalidPrice: "Enter a valid ZEC price.",
      invalidPayoutAddress: "Enter a valid Zcash Unified Address to receive.",
      missingOrder: "Paste a valid link or order id.",
      serverError: "Paid link failed: ",
      paymentRequired: "Payment is not confirmed yet. Wait for the webhook or try again after checkout.",
    },
  },
};

export function getPaidPrivateFileCopy(
  locale: ProductLocale,
): PaidPrivateFileCopy {
  return COPY[locale];
}
