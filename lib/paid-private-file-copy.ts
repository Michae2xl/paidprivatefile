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
  brand: {
    zcash: string;
    nym: string;
    cipherpay: string;
    railLabel: string;
    railBody: string;
  };
  motion: {
    title: string;
    body: string;
    transferLabel: string;
    transferBody: string;
    paymentLabel: string;
    paymentBody: string;
    doneLabel: string;
    doneBody: string;
  };
  seller: {
    title: string;
    body: string;
    createTab: string;
    loginTab: string;
    handleLabel: string;
    handlePlaceholder: string;
    displayNameLabel: string;
    displayNamePlaceholder: string;
    accessKeyLabel: string;
    accessKeyPlaceholder: string;
    createLabel: string;
    loginLabel: string;
    publicRouteLabel: string;
    loggedInLabel: string;
    accessKeySavedTitle: string;
    accessKeySavedBody: string;
    accessKeyCopyLabel: string;
    accessKeyCopiedLabel: string;
    accessKeyConfirmLabel: string;
    accessKeyBlocker: string;
    ufvkLabel: string;
    ufvkPlaceholder: string;
    ufvkHint: string;
    ufvkWarningTitle: string;
    ufvkWarningBody: string;
    ufvkConfirmedTitle: string;
    ufvkConfirmedBody: string;
    ufvkFingerprintLabel: string;
    ufvkAddressLabel: string;
    sectionIdentityTitle: string;
    sectionPayoutTitle: string;
    sectionPayoutNote: string;
    ufvkAckLabel: string;
    ufvkPreviewChecking: string;
    ufvkPreviewReceives: string;
    ufvkPreviewInvalid: string;
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
    nymAddressLabel: string;
    nymAddressPlaceholder: string;
    nymAddressHint: string;
    startNymLabel: string;
    nymReadyLabel: string;
    nymStartingLabel: string;
    nymWaitingLabel: string;
    privateReceiverLabel: string;
    privateReceiverBody: string;
    manualNymLabel: string;
    manualNymHideLabel: string;
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
    sellerPayoutAddressHint: string;
    file: string;
    size: string;
    status: string;
    paymentAddress: string;
    paymentMemo: string;
    invoice: string;
    privateDelivery: string;
    nymSession: string;
    qrCaption: string;
    qrAlt: string;
  };
  errors: {
    missingFile: string;
    invalidPrice: string;
    invalidPayoutAddress: string;
    ufvkRequired: string;
    missingOrder: string;
    missingNymAddress: string;
    nymUnavailable: string;
    serverError: string;
    paymentRequired: string;
  };
}

const COPY: Record<ProductLocale, PaidPrivateFileCopy> = {
  pt: {
    shell: {
      eyebrow: "Paid Private File",
      title:
        "Pagamento em ZEC. Entrega privada via Nym. Arquivo abre so localmente.",
      body: "O arquivo e cifrado antes do upload. O pagamento em ZEC desbloqueia uma sessao privada Nym para entregar a chave ao comprador, sem expor o conteudo do arquivo.",
      backLabel: "Paid Private File",
    },
    tabs: {
      send: "Enviar arquivo",
      receive: "Abrir link",
    },
    brand: {
      zcash: "Zcash",
      nym: "Nym",
      cipherpay: "CipherPay",
      railLabel: "Zcash + Nym private rail",
      railBody:
        "Pagamento em ZEC entra pelo checkout. A chave privada sai pela Nym.",
    },
    motion: {
      title: "Fluxo privado",
      body: "Um arquivo, um pagamento, uma entrega privada.",
      transferLabel: "Arquivo em transito",
      transferBody: "Ciphertext salvo. A chave fica fora do link publico.",
      paymentLabel: "Aguardando ZEC",
      paymentBody: "O invoice confirma antes da entrega da chave.",
      doneLabel: "Feito",
      doneBody: "Buyer recebe a chave pela Nym e decripta localmente.",
    },
    seller: {
      title: "Private shop sem e-mail",
      body: "Crie uma rota publica, configure sua wallet ZEC e use uma chave de acesso para entrar depois.",
      createTab: "Criar shop",
      loginTab: "Entrar",
      handleLabel: "Rota publica",
      handlePlaceholder: "meu-handle",
      displayNameLabel: "Nome publico",
      displayNamePlaceholder: "Minha loja de arquivos",
      accessKeyLabel: "Chave de acesso",
      accessKeyPlaceholder: "ppf_...",
      createLabel: "Criar private shop",
      loginLabel: "Entrar sem e-mail",
      publicRouteLabel: "Rota publica",
      loggedInLabel: "Private shop ativo",
      accessKeySavedTitle: "Chave do private shop",
      accessKeySavedBody:
        "Ela aparece uma vez e nao pode ser recuperada pelo servidor. Guarde fora do navegador antes de publicar arquivos.",
      accessKeyCopyLabel: "Copiar chave",
      accessKeyCopiedLabel: "Chave copiada",
      accessKeyConfirmLabel: "Eu guardei esta chave",
      accessKeyBlocker:
        "Confirme que guardou a chave para liberar a publicacao do arquivo.",
      ufvkLabel: "Chave de visualizacao da loja (UFVK)",
      ufvkPlaceholder: "uview1...",
      ufvkHint:
        "A plataforma usa esta chave somente para detectar pagamentos. Ela nao permite gastar.",
      ufvkWarningTitle: "Use uma conta ZEC dedicada",
      ufvkWarningBody:
        "Crie uma conta de carteira separada so para esta loja e cole a UFVK dela. A chave de visualizacao revela todo o historico da conta para a plataforma. NUNCA use a UFVK da sua carteira principal.",
      ufvkConfirmedTitle: "Chave de visualizacao registrada",
      ufvkConfirmedBody:
        "A plataforma vai derivar um endereco unico por pedido a partir desta chave.",
      ufvkFingerprintLabel: "Fingerprint",
      ufvkAddressLabel: "Endereco que recebe",
      sectionIdentityTitle: "Identidade da loja",
      sectionPayoutTitle: "Receber pagamentos (nao-custodial)",
      sectionPayoutNote:
        "O comprador paga um endereco unico por pedido, derivado da sua chave de visualizacao — o dinheiro vai direto pra sua conta. Voce nao cola nenhum endereco.",
      ufvkAckLabel:
        "Entendi: vou usar uma conta dedicada, nao a minha carteira principal.",
      ufvkPreviewChecking: "Verificando a chave...",
      ufvkPreviewReceives: "Recebe em",
      ufvkPreviewInvalid: "Chave de visualizacao invalida",
    },
    send: {
      title: "Criar arquivo privado pago",
      body: "Escolha o arquivo, defina o preco em ZEC e compartilhe acesso privado. O servidor guarda ciphertext; a entrega da chave e tratada como sessao Nym.",
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
      successBody:
        "Compartilhe o link de acesso. O arquivo so abre depois que o pagamento em ZEC for confirmado.",
      copyLinkLabel: "Copiar link",
      openLinkLabel: "Abrir link",
    },
    receive: {
      title: "Pagar e abrir localmente",
      body: "Carregue o link, registre sua sessao Nym, pague o invoice em ZEC e abra o arquivo localmente.",
      orderLabel: "Paid Private File",
      orderPlaceholder: "Cole o link do arquivo ou order id",
      nymAddressLabel: "Endereco Nym do comprador",
      nymAddressPlaceholder: "nym...",
      nymAddressHint:
        "A chave do arquivo deve ser entregue por uma sessao Nym apos o pagamento.",
      startNymLabel: "Iniciar receptor Nym",
      nymReadyLabel: "Receptor Nym pronto",
      nymStartingLabel: "Conectando Nym...",
      nymWaitingLabel: "Aguardando entrega privada pela Nym...",
      privateReceiverLabel: "Receptor privado",
      privateReceiverBody:
        "O browser prepara a sessao Nym automaticamente antes do pagamento. Voce nao precisa colar endereco.",
      manualNymLabel: "Usar endereco Nym manual",
      manualNymHideLabel: "Ocultar endereco manual",
      loadLabel: "Carregar",
      payLabel: "Criar pagamento",
      checkoutLabel: "Pagar em ZEC",
      devPayLabel: "Confirmar pagamento dev",
      unlockLabel: "Baixar e abrir",
      downloadLabel: "Salvar arquivo aberto",
      paidStatus: "Pagamento confirmado",
      pendingStatus: "Aguardando pagamento",
    },
    details: {
      price: "Preco",
      sellerPayoutAddress: "Carteira do vendedor (nao pague aqui)",
      sellerPayoutAddressHint:
        "Aqui e onde o vendedor recebe. Nao envie ZEC para este endereco: pague o Endereco de pagamento mostrado depois de criar o pagamento.",
      file: "Arquivo",
      size: "Tamanho",
      status: "Status",
      paymentAddress: "Endereco de pagamento",
      paymentMemo: "Memo",
      invoice: "Invoice",
      privateDelivery: "Entrega privada",
      nymSession: "Sessao Nym",
      qrCaption: "Escaneie para pagar - {price} ZEC",
      qrAlt: "QR code do pagamento Zcash",
    },
    errors: {
      missingFile: "Escolha um arquivo antes de criar o link.",
      invalidPrice: "Informe um preco valido em ZEC.",
      invalidPayoutAddress:
        "Informe uma Unified Address Zcash valida para receber.",
      ufvkRequired:
        "Cole a chave de visualizacao (UFVK) de uma conta dedicada e confirme o aviso.",
      missingOrder: "Cole um link ou order id valido.",
      missingNymAddress:
        "Informe um endereco Nym para receber a chave privada.",
      nymUnavailable: "Nao foi possivel iniciar o receptor Nym no browser.",
      serverError: "Falha no paid link: ",
      paymentRequired:
        "Pagamento ainda nao confirmado. Aguarde o webhook ou tente novamente depois do checkout.",
    },
  },
  en: {
    shell: {
      eyebrow: "Paid Private File",
      title: "ZEC payment. Private Nym delivery. Local-only file opening.",
      body: "The file is encrypted before upload. The ZEC payment unlocks a private Nym delivery session for the buyer key, without exposing the file content.",
      backLabel: "Paid Private File",
    },
    tabs: {
      send: "Send file",
      receive: "Open link",
    },
    brand: {
      zcash: "Zcash",
      nym: "Nym",
      cipherpay: "CipherPay",
      railLabel: "Zcash + Nym private rail",
      railBody:
        "ZEC payment enters through checkout. The private key exits through Nym.",
    },
    motion: {
      title: "Private flow",
      body: "One file, one payment, one private delivery.",
      transferLabel: "File in transit",
      transferBody: "Ciphertext stored. The key stays out of the public link.",
      paymentLabel: "Waiting for ZEC",
      paymentBody: "The invoice confirms before key delivery.",
      doneLabel: "Done",
      doneBody: "Buyer receives the key through Nym and decrypts locally.",
    },
    seller: {
      title: "No-email private shop",
      body: "Create a public route, configure your ZEC wallet, and use an access key to log in later.",
      createTab: "Create shop",
      loginTab: "Log in",
      handleLabel: "Public route",
      handlePlaceholder: "my-handle",
      displayNameLabel: "Public name",
      displayNamePlaceholder: "My private file shop",
      accessKeyLabel: "Access key",
      accessKeyPlaceholder: "ppf_...",
      createLabel: "Create private shop",
      loginLabel: "Log in without email",
      publicRouteLabel: "Public route",
      loggedInLabel: "Active private shop",
      accessKeySavedTitle: "Private shop key",
      accessKeySavedBody:
        "It is shown once and cannot be recovered by the server. Save it outside the browser before publishing files.",
      accessKeyCopyLabel: "Copy key",
      accessKeyCopiedLabel: "Key copied",
      accessKeyConfirmLabel: "I saved this key",
      accessKeyBlocker:
        "Confirm that you saved the key to unlock file publishing.",
      ufvkLabel: "Shop viewing key (UFVK)",
      ufvkPlaceholder: "uview1...",
      ufvkHint:
        "The platform uses this key only to detect payments. It cannot spend.",
      ufvkWarningTitle: "Use a dedicated ZEC account",
      ufvkWarningBody:
        "Create a separate wallet account just for this shop and paste its UFVK. A viewing key reveals the account's full history to the platform. NEVER use your main wallet's UFVK.",
      ufvkConfirmedTitle: "Viewing key registered",
      ufvkConfirmedBody:
        "The platform will derive a unique per-order address from this key.",
      ufvkFingerprintLabel: "Fingerprint",
      ufvkAddressLabel: "Receiving address",
      sectionIdentityTitle: "Shop identity",
      sectionPayoutTitle: "Get paid (non-custodial)",
      sectionPayoutNote:
        "Buyers pay a unique address per order, derived from your viewing key — funds go straight to your account. You never paste an address.",
      ufvkAckLabel:
        "I understand: I'll use a dedicated account, not my main wallet.",
      ufvkPreviewChecking: "Checking the key...",
      ufvkPreviewReceives: "Receives at",
      ufvkPreviewInvalid: "Invalid viewing key",
    },
    send: {
      title: "Create paid private file",
      body: "Pick a file, set the ZEC price, and share private access. The server stores ciphertext; key delivery is treated as a Nym session.",
      fileLabel: "Private file",
      chooseFileLabel: "Choose file",
      emptyFileLabel: "No file selected",
      priceLabel: "Price in ZEC",
      priceHint: "Example: 0.05 ZEC. The value is converted to zatoshis.",
      payoutAddressLabel: "Wallet to receive ZEC",
      payoutAddressPlaceholder: "u1...",
      payoutAddressHint: "The buyer payment should go to this Unified Address.",
      noteLabel: "Note for buyer",
      notePlaceholder: "Optional",
      submitLabel: "Create paid private file",
      busyLabel: "Encrypting and creating link...",
      successTitle: "Private file ready",
      successBody:
        "Share the access link. The file opens only after the ZEC payment is confirmed.",
      copyLinkLabel: "Copy link",
      openLinkLabel: "Open link",
    },
    receive: {
      title: "Pay and open locally",
      body: "Load the link, register your Nym session, pay the ZEC invoice, and open the file locally.",
      orderLabel: "Paid Private File",
      orderPlaceholder: "Paste file link or order id",
      nymAddressLabel: "Buyer Nym address",
      nymAddressPlaceholder: "nym...",
      nymAddressHint:
        "The file key should be delivered through a Nym session after payment.",
      startNymLabel: "Start Nym receiver",
      nymReadyLabel: "Nym receiver ready",
      nymStartingLabel: "Connecting Nym...",
      nymWaitingLabel: "Waiting for private Nym delivery...",
      privateReceiverLabel: "Private receiver",
      privateReceiverBody:
        "The browser prepares the Nym session automatically before payment. No address paste needed.",
      manualNymLabel: "Use manual Nym address",
      manualNymHideLabel: "Hide manual address",
      loadLabel: "Load",
      payLabel: "Create payment",
      checkoutLabel: "Pay in ZEC",
      devPayLabel: "Confirm dev payment",
      unlockLabel: "Download and open",
      downloadLabel: "Save opened file",
      paidStatus: "Payment confirmed",
      pendingStatus: "Waiting for payment",
    },
    details: {
      price: "Price",
      sellerPayoutAddress: "Seller's wallet (do not pay here)",
      sellerPayoutAddressHint:
        "This is where the seller gets paid. Do not send ZEC to this address: pay the Payment address shown after you create the payment.",
      file: "File",
      size: "Size",
      status: "Status",
      paymentAddress: "Payment address",
      paymentMemo: "Memo",
      invoice: "Invoice",
      privateDelivery: "Private delivery",
      nymSession: "Nym session",
      qrCaption: "Scan to pay - {price} ZEC",
      qrAlt: "Zcash payment QR code",
    },
    errors: {
      missingFile: "Choose a file before creating the link.",
      invalidPrice: "Enter a valid ZEC price.",
      invalidPayoutAddress: "Enter a valid Zcash Unified Address to receive.",
      ufvkRequired:
        "Paste a dedicated account's viewing key (UFVK) and confirm the warning.",
      missingOrder: "Paste a valid link or order id.",
      missingNymAddress: "Enter a Nym address to receive the private key.",
      nymUnavailable: "Could not start the browser Nym receiver.",
      serverError: "Paid link failed: ",
      paymentRequired:
        "Payment is not confirmed yet. Wait for the webhook or try again after checkout.",
    },
  },
};

export function getPaidPrivateFileCopy(
  locale: ProductLocale,
): PaidPrivateFileCopy {
  return COPY[locale];
}
