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
    accessKeyCalloutBody: string;
    accessKeyCopyLabel: string;
    accessKeyCopiedLabel: string;
    accessKeyConfirmLabel: string;
    accessKeySavedAckLabel: string;
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
    loginHint: string;
  };
  dashboard: {
    createFileCta: string;
    keepTabOpenBanner: string;
    signOutLabel: string;
    backToDashboard: string;
    tabDashboard: string;
    tabFiles: string;
    tabSettings: string;
    receivingTitle: string;
    receivingTag: string;
    receivingAccountLabel: string;
    viewingKeyLabel: string;
    viewingKeyHeldBy: string;
    viewingKeyNone: string;
    networkLabel: string;
    receivingHelper: string;
    accessKeyReminderTitle: string;
    accessKeyReminderBody: string;
    accessKeyRegenerateTitle: string;
    accessKeyRegenerateWarning: string;
    accessKeyRegenerateLabel: string;
    accessKeyRegenerateConfirmLabel: string;
    accessKeyRegenerateCancelLabel: string;
    accessKeyRegeneratingLabel: string;
    filesTitle: string;
    filesEmptyTitle: string;
    filesEmptyBody: string;
    filesLoading: string;
    fileOpenLabel: string;
    fileCopyLinkLabel: string;
    fileLinkCopiedLabel: string;
    settingsTitle: string;
    settingsIdentityTitle: string;
    settingsDisplayNameLabel: string;
    settingsSaveLabel: string;
    settingsSavedLabel: string;
    settingsSavingLabel: string;
    settingsReceivingTitle: string;
    settingsPublicLinkTitle: string;
    settingsPublicLinkCopy: string;
    settingsPublicLinkCopied: string;
    statusCreated: string;
    statusPaymentPending: string;
    statusPaid: string;
    statusClaimed: string;
    statusDetecting: string;
    statusPaidReady: string;
    // Delivery is not "Delivered" until the buyer ACKs over Nym
    // (nymSession.status === "delivered"). Before that, a paid/claimed order is
    // still in flight: "Awaiting delivery" (released, not yet sent/claimed) and
    // "Delivering" (claimed, key in transit over Nym, buyer not yet acked).
    statusAwaitingDelivery: string;
    statusDelivering: string;
    // Delivery-path suffix appended to a DELIVERED file row, e.g.
    // "Delivered · Nym" vs "Delivered · HTTPS". Backward-compatible: a delivered
    // order with no recorded path shows the bare "Delivered" with no suffix.
    deliveredViaNymSuffix: string;
    deliveredViaHttpsSuffix: string;
    fileManageLabel: string;
    fileReleaseLabel: string;
    manageTitle: string;
    manageLoading: string;
    manageError: string;
    manageStatusLabel: string;
    secretMissingTitle: string;
    secretMissingBody: string;
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
    shareWarningTitle: string;
    shareWarningBody: string;
  };
  // Multi-buyer "product" model (Phase 3a): supply control on the create form +
  // the product success state. Only rendered when the products feature flag is on;
  // with the flag off none of these strings are reachable.
  products: {
    supplyLabel: string;
    supplyHint: string;
    supplyOpenLabel: string;
    supplyLimitedLabel: string;
    supplyMaxLabel: string;
    supplyMaxPlaceholder: string;
    supplyMaxInvalid: string;
    submitLabel: string;
    busyLabel: string;
    successTitle: string;
    successBody: string;
    // Dashboard products list (rendered alongside the single-use files).
    listTitle: string;
    listEmptyTitle: string;
    listEmptyBody: string;
    listLoading: string;
    copyLinkLabel: string;
    linkCopiedLabel: string;
    // Supply summary on a product row: "Open" for unlimited, "{sold} / {max} sold"
    // for a limited product.
    supplyOpenSummary: string;
    supplyLimitedSummary: string;
    soldOutLabel: string;
    productBadge: string;
  };
  // Multi-buyer "product" model (Phase 3b): the BUYER-facing product page (open a
  // product link, see the listing, Buy -> spawns an order -> existing pay/receive
  // flow). Separate from `products` (which is the SELLER's create/dashboard copy).
  productBuy: {
    eyebrow: string;
    title: string;
    body: string;
    loading: string;
    errorTitle: string;
    errorBody: string;
    // "{left}" is replaced with the remaining unit count for a limited product.
    supplyLimited: string;
    supplyOpen: string;
    soldOut: string;
    soldOutTitle: string;
    soldOutBody: string;
    buyLabel: string;
    buyingLabel: string;
  };
  // Multi-buyer "product" model (Phase 3b): the per-product PURCHASES sub-list in
  // the seller dashboard. "{count}" is the number of purchases of the product.
  purchases: {
    title: string;
    emptyLabel: string;
    deliveringLabel: string;
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
    paymentAddressHint: string;
    // Dead-simple buyer flow (auto QR + polling + confirmation modal).
    payHeadline: string;
    payHelper: string;
    preparingPaymentLabel: string;
    // 0-conf "Payment detected": shown the instant the scanner reports a mempool
    // sighting, before the payment is confirmed (file stays locked).
    detectedTitle: string;
    detectedBody: string;
    inTransitTitle: string;
    inTransitBody: string;
    copyAddressLabel: string;
    copyAddressDoneLabel: string;
    modalTitle: string;
    modalBody: string;
    modalDownloadLabel: string;
    modalPreparingLabel: string;
    modalCloseLabel: string;
    doneTitle: string;
    doneBody: string;
    // Dead-simple buyer: a single "Receiving your file…" spinner card (no
    // stepper) while the package is in flight over Nym, then an auto-download
    // "your file arrived" done card with a single "Save file" fallback button.
    receivingTitle: string;
    receivingBody: string;
    arrivedTitle: string;
    arrivedBody: string;
    saveFileLabel: string;
    // Browser-to-browser file transfer over Nym: progress label shown in the
    // "Receiving your file…" card while the encrypted file streams over the
    // mixnet. "{percent}" is replaced with the integer percent received.
    receivingOverNym: string;
    // Provenance badge on the "YOUR FILE ARRIVED" card: proves which path
    // actually delivered the file. "nym" = streamed over the mixnet; "https" =
    // the Nym fallback fetch.
    receivedViaNym: string;
    receivedViaHttps: string;
  };
  // Buyer status stepper + Nym receiver health (visibility into where a transfer
  // is). All layperson, en + pt.
  buyerStatus: {
    title: string;
    stepAwaitingPayment: string;
    stepAwaitingPaymentBody: string;
    stepInTransit: string;
    stepInTransitBody: string;
    stepPaid: string;
    stepPaidBody: string;
    stepReceivingKey: string;
    stepReceivingKeyBody: string;
    stepDone: string;
    stepDoneBody: string;
    nymConnected: string;
    nymConnecting: string;
    nymNotConnected: string;
    nymAddressLabel: string;
    reconnectNymLabel: string;
    keepTabOpenHint: string;
    // Compact diagnostic shown inside the "Receiving your file…" card so the
    // buyer (and support) can SEE whether the in-browser Nym receiver is live.
    receiverStatusLabel: string;
    receiverAddressEmpty: string;
    receiverEnvelopesLabel: string;
  };
  // Seller status stepper + robust re-send controls.
  sellerStatus: {
    title: string;
    stepAwaitingPayment: string;
    stepPaid: string;
    stepReleased: string;
    stepSent: string;
    stepDelivered: string;
    resendLabel: string;
    resendingLabel: string;
    autoResendingLabel: string;
    deliveredToBuyer: string;
    notDeliveredYet: string;
    keepTabOpenHint: string;
    // Browser-to-browser file transfer over Nym: progress label shown while the
    // seller browser streams the encrypted file to the buyer over the mixnet.
    // "{percent}" is replaced with the integer percent sent.
    sendingOverNym: string;
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
    displayNameTaken: string;
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
      send: "Painel",
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
      accessKeyCalloutBody:
        "Esta e a unica forma de entrar de novo. Ela aparece uma unica vez — copie agora e guarde em um lugar seguro.",
      accessKeyCopyLabel: "Copiar chave",
      accessKeyCopiedLabel: "Chave copiada",
      accessKeyConfirmLabel: "Eu guardei esta chave",
      accessKeySavedAckLabel: "Ja guardei",
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
      loginHint: "Entre apenas com a sua access key (ppf_...).",
    },
    dashboard: {
      createFileCta: "Criar arquivo pago",
      keepTabOpenBanner:
        "Mantenha esta aba aberta: e o seu navegador que entrega os arquivos aos compradores pela Nym. Fecha-la pausa as entregas pendentes.",
      signOutLabel: "Sair",
      backToDashboard: "Voltar ao painel",
      tabDashboard: "Painel",
      tabFiles: "Arquivos",
      tabSettings: "Configuracoes",
      receivingTitle: "Recebendo - nao-custodial",
      receivingTag: "guardado pelo scanner",
      receivingAccountLabel: "Conta que recebe",
      viewingKeyLabel: "Chave de visualizacao",
      viewingKeyHeldBy: "guardada pelo scanner",
      viewingKeyNone: "nenhuma registrada",
      networkLabel: "Rede",
      receivingHelper:
        "Cada venda recebe um endereco unico derivado desta chave. Detectamos pagamentos somente em modo de leitura - nunca podemos gastar.",
      accessKeyReminderTitle: "Chave de acesso",
      accessKeyReminderBody:
        "Sua chave de acesso aparece apenas uma vez na criacao da loja. Guarde-a fora do navegador: e a unica forma de entrar de novo.",
      accessKeyRegenerateTitle: "Gerar nova chave de acesso",
      accessKeyRegenerateWarning:
        "Isto substitui sua chave de acesso atual — a antiga para de funcionar imediatamente.",
      accessKeyRegenerateLabel: "Gerar nova chave",
      accessKeyRegenerateConfirmLabel: "Confirmar",
      accessKeyRegenerateCancelLabel: "Cancelar",
      accessKeyRegeneratingLabel: "Gerando...",
      filesTitle: "Seus arquivos",
      filesEmptyTitle: "Nenhum arquivo ainda",
      filesEmptyBody: "Crie seu primeiro arquivo pago para comecar a vender.",
      filesLoading: "Carregando arquivos...",
      fileOpenLabel: "Abrir",
      fileCopyLinkLabel: "Copiar link",
      fileLinkCopiedLabel: "Link copiado",
      settingsTitle: "Configuracoes",
      settingsIdentityTitle: "Identidade da loja",
      settingsDisplayNameLabel: "Nome publico",
      settingsSaveLabel: "Salvar",
      settingsSavedLabel: "Salvo",
      settingsSavingLabel: "Salvando...",
      settingsReceivingTitle: "Recebendo (nao-custodial)",
      settingsPublicLinkTitle: "Link publico",
      settingsPublicLinkCopy: "Copiar link",
      settingsPublicLinkCopied: "Link copiado",
      statusCreated: "Criado",
      statusPaymentPending: "Aguardando pagamento",
      statusPaid: "Pago",
      statusClaimed: "Entregue",
      statusDetecting: "Detectando pagamento",
      statusPaidReady: "Pago - pronto para entregar",
      statusAwaitingDelivery: "Aguardando entrega",
      statusDelivering: "Entregando",
      deliveredViaNymSuffix: " · Nym",
      deliveredViaHttpsSuffix: " · HTTPS",
      fileManageLabel: "Gerenciar",
      fileReleaseLabel: "Liberar chave",
      manageTitle: "Liberar chave do arquivo",
      manageLoading: "Carregando pedido...",
      manageError: "Nao foi possivel carregar este pedido.",
      manageStatusLabel: "Status",
      secretMissingTitle: "Segredo em outro dispositivo",
      secretMissingBody:
        "Este arquivo foi criado em outro dispositivo/navegador. Abra a loja la para liberar a chave. A custodia e do vendedor: a chave so pode ser liberada do navegador que criou o arquivo.",
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
      shareWarningTitle: "Importante",
      shareWarningBody:
        "Abra este link em outro navegador ou dispositivo, não neste. O primeiro navegador que abrir o link vira o comprador, e a entrega pela Nym precisa de dois navegadores separados. Venda um arquivo por vez e mantenha esta aba aberta até o comprador confirmar o recebimento.",
    },
    products: {
      supplyLabel: "Estoque",
      supplyHint:
        "Quantos compradores podem adquirir este produto. Ilimitado vende sem limite; Limitado esgota apos atingir a quantidade.",
      supplyOpenLabel: "Ilimitado (aberto)",
      supplyLimitedLabel: "Limitado",
      supplyMaxLabel: "Quantidade",
      supplyMaxPlaceholder: "Ex: 10",
      supplyMaxInvalid: "A quantidade deve ser um numero inteiro positivo.",
      submitLabel: "Criar produto",
      busyLabel: "Cifrando e criando produto...",
      successTitle: "Produto publicado",
      successBody:
        "Compartilhe o link do produto. Cada comprador recebe o proprio pedido; o arquivo so abre depois do pagamento em ZEC.",
      listTitle: "Seus produtos",
      listEmptyTitle: "Nenhum produto ainda",
      listEmptyBody:
        "Crie um produto para vender o mesmo arquivo para varios compradores.",
      listLoading: "Carregando produtos...",
      copyLinkLabel: "Copiar link do produto",
      linkCopiedLabel: "Link copiado",
      supplyOpenSummary: "Aberto",
      supplyLimitedSummary: "{sold} / {max} vendidos",
      soldOutLabel: "Esgotado",
      productBadge: "Produto",
    },
    productBuy: {
      eyebrow: "Comprar produto",
      title: "Compre este arquivo privado",
      body: "Pague em ZEC e receba o arquivo de forma privada por uma sessao Nym apos a confirmacao do pagamento.",
      loading: "Carregando produto...",
      errorTitle: "Produto indisponivel",
      errorBody:
        "Este produto nao foi encontrado ou nao esta mais a venda. Confira o link com o vendedor.",
      supplyLimited: "{left} restantes",
      supplyOpen: "Disponivel",
      soldOut: "Esgotado",
      soldOutTitle: "Esgotado",
      soldOutBody:
        "Todas as unidades deste produto ja foram vendidas. Fale com o vendedor para uma nova remessa.",
      buyLabel: "Comprar",
      buyingLabel: "Iniciando compra...",
    },
    purchases: {
      title: "Compras ({count})",
      emptyLabel: "Nenhuma compra ainda",
      deliveringLabel: "Entregando pela Nym...",
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
      paymentAddressHint:
        "Seu endereco de pagamento + QR aparecem depois que voce criar o pagamento.",
      payHeadline: "Escaneie e pague para abrir",
      payHelper: "Escaneie o QR e pague em ZEC. So isso.",
      preparingPaymentLabel: "Preparando seu pagamento...",
      detectedTitle: "Pagamento detectado",
      detectedBody:
        "Vimos seu pagamento na rede e estamos aguardando a confirmacao. Pode deixar esta pagina aberta.",
      inTransitTitle: "Pagamento em transito",
      inTransitBody:
        "Recebemos seu pagamento e estamos confirmando. Pode deixar esta pagina aberta.",
      copyAddressLabel: "Copiar endereco",
      copyAddressDoneLabel: "Endereco copiado",
      modalTitle: "Pagamento confirmado!",
      modalBody: "Baixe seu arquivo.",
      modalDownloadLabel: "Baixar arquivo",
      modalPreparingLabel: "Preparando seu arquivo...",
      modalCloseLabel: "Fechar",
      doneTitle: "Concluido",
      doneBody:
        "Seu arquivo esta pronto e aparece abaixo. Toque em Baixar para salvar (ou pressione e segure a imagem).",
      receivingTitle: "Recebendo seu arquivo...",
      receivingBody:
        "Pagamento confirmado. Estamos trazendo seu arquivo com seguranca. Pode deixar esta pagina aberta.",
      arrivedTitle: "Seu arquivo chegou - salvando agora.",
      arrivedBody:
        "O download deve comecar sozinho. Se nao comecar, toque em Salvar arquivo.",
      saveFileLabel: "Salvar arquivo",
      receivingOverNym: "Recebendo pela Nym... {percent}%",
      receivedViaNym: "✓ Recebido pela Nym (mixnet)",
      receivedViaHttps: "↩ Recebido por HTTPS (fallback Nym)",
    },
    buyerStatus: {
      title: "Status da sua compra",
      stepAwaitingPayment: "Aguardando pagamento",
      stepAwaitingPaymentBody: "Escaneie o QR e pague em ZEC para abrir.",
      stepInTransit: "Pagamento detectado",
      stepInTransitBody: "Recebemos seu pagamento e estamos confirmando.",
      stepPaid: "Pago",
      stepPaidBody: "Pagamento confirmado. Preparando a entrega da chave.",
      stepReceivingKey: "Recebendo a chave (Nym)",
      stepReceivingKeyBody:
        "A chave esta chegando pela rede Nym. Mantenha esta aba aberta.",
      stepDone: "Concluido",
      stepDoneBody: "Arquivo baixado e aberto neste navegador.",
      nymConnected: "Conectado a Nym - aguardando a chave",
      nymConnecting: "Conectando a Nym...",
      nymNotConnected: "Sem conexao Nym - tente reconectar",
      nymAddressLabel: "Seu endereco Nym",
      reconnectNymLabel: "Reconectar Nym",
      keepTabOpenHint:
        "Mantenha esta aba aberta. Se demorar, clique em Reconectar Nym - o vendedor reenvia a chave automaticamente.",
      receiverStatusLabel: "Receptor Nym",
      receiverAddressEmpty: "—",
      receiverEnvelopesLabel: "envelopes",
    },
    sellerStatus: {
      title: "Status da entrega",
      stepAwaitingPayment: "Aguardando pagamento",
      stepPaid: "Pago",
      stepReleased: "Chave liberada",
      stepSent: "Enviada pela Nym",
      stepDelivered: "Entregue ao comprador",
      resendLabel: "Reenviar chave pela Nym",
      resendingLabel: "Reenviando...",
      autoResendingLabel: "Reenviando pela Nym...",
      deliveredToBuyer: "Entregue ao comprador",
      notDeliveredYet:
        "Enviada pela Nym, aguardando confirmacao do comprador. Reenviando automaticamente enquanto esta tela estiver aberta.",
      keepTabOpenHint:
        "Mantenha esta tela aberta ate aparecer Entregue ao comprador.",
      sendingOverNym: "Enviando pela Nym... {percent}%",
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
      displayNameTaken: "Esse nome publico ja esta em uso.",
    },
  },
  en: {
    shell: {
      eyebrow: "Paid Private File",
      title:
        "Pay in ZEC. Key and file delivered over Nym. Decrypted on your device.",
      body: "Encrypted in your browser. Paid in ZEC. The decryption key and the encrypted file reach the buyer browser-to-browser, 100% over the Nym mixnet. Decrypted only on their device. Non-custodial, end to end.",
      backLabel: "Paid Private File",
    },
    tabs: {
      send: "Dashboard",
      receive: "Open link",
    },
    brand: {
      zcash: "Zcash",
      nym: "Nym",
      cipherpay: "CipherPay",
      railLabel: "Zcash pays. Nym delivers.",
      railBody:
        "ZEC goes straight to the seller's own address (platform watches view-only). The decryption key and the encrypted file then travel over the Nym mixnet.",
    },
    motion: {
      title: "How it works",
      body: "Encrypt locally, pay in ZEC, deliver over Nym, decrypt on your device.",
      transferLabel: "Encrypted and stored",
      transferBody:
        "Encrypted in the browser. The server only ever holds ciphertext — the decryption key never reaches it.",
      paymentLabel: "Paid in ZEC",
      paymentBody: "The on-chain ZEC payment confirms before delivery begins.",
      doneLabel: "Done",
      doneBody:
        "Buyer receives the key and file over Nym, then decrypts on their device.",
    },
    seller: {
      title: "Your shop. No email, no custody.",
      body: "Create a public route, add a view-only key to receive ZEC, and log back in later with an access key.",
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
      accessKeyCalloutBody:
        "This is the only way to log back in. It is shown once — copy it now and store it somewhere safe.",
      accessKeyCopyLabel: "Copy key",
      accessKeyCopiedLabel: "Key copied",
      accessKeyConfirmLabel: "I saved this key",
      accessKeySavedAckLabel: "I've saved it",
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
        "Each order gets its own address, derived from your viewing key — funds go straight to your account. We can detect payments view-only but never touch them. You never paste an address.",
      ufvkAckLabel:
        "I understand: I'll use a dedicated account, not my main wallet.",
      ufvkPreviewChecking: "Checking the key...",
      ufvkPreviewReceives: "Receives at",
      ufvkPreviewInvalid: "Invalid viewing key",
      loginHint: "Log in with just your access key (ppf_...).",
    },
    dashboard: {
      createFileCta: "Create paid file",
      keepTabOpenBanner:
        "Keep this tab open: your browser is what delivers files to buyers over Nym. Closing it pauses pending deliveries until you reopen.",
      signOutLabel: "Sign out",
      backToDashboard: "Back to files",
      tabDashboard: "Files",
      tabFiles: "Files",
      tabSettings: "Settings",
      receivingTitle: "Receiving - non-custodial",
      receivingTag: "held by scanner",
      receivingAccountLabel: "Receiving account",
      viewingKeyLabel: "Viewing key",
      viewingKeyHeldBy: "held by scanner",
      viewingKeyNone: "none registered",
      networkLabel: "Network",
      receivingHelper:
        "Each sale gets a unique address derived from this key, paid straight to your own account. We detect payments view-only and can never spend or move funds.",
      accessKeyReminderTitle: "Access key",
      accessKeyReminderBody:
        "Your access key is shown only once when the shop is created. Keep it outside the browser: it is the only way to log back in.",
      accessKeyRegenerateTitle: "Regenerate access key",
      accessKeyRegenerateWarning:
        "This replaces your current access key — the old one stops working immediately.",
      accessKeyRegenerateLabel: "Regenerate",
      accessKeyRegenerateConfirmLabel: "Confirm",
      accessKeyRegenerateCancelLabel: "Cancel",
      accessKeyRegeneratingLabel: "Regenerating...",
      filesTitle: "Your files",
      filesEmptyTitle: "No files yet",
      filesEmptyBody: "Create your first paid file to start selling.",
      filesLoading: "Loading files...",
      fileOpenLabel: "Open",
      fileCopyLinkLabel: "Copy link",
      fileLinkCopiedLabel: "Link copied",
      settingsTitle: "Settings",
      settingsIdentityTitle: "Shop identity",
      settingsDisplayNameLabel: "Public name",
      settingsSaveLabel: "Save",
      settingsSavedLabel: "Saved",
      settingsSavingLabel: "Saving...",
      settingsReceivingTitle: "Receiving (non-custodial)",
      settingsPublicLinkTitle: "Public link",
      settingsPublicLinkCopy: "Copy link",
      settingsPublicLinkCopied: "Link copied",
      statusCreated: "Created",
      statusPaymentPending: "Awaiting payment",
      statusPaid: "Paid",
      statusClaimed: "Delivered",
      statusDetecting: "Detecting payment",
      statusPaidReady: "Paid - ready to deliver",
      statusAwaitingDelivery: "Awaiting delivery",
      statusDelivering: "Delivering",
      deliveredViaNymSuffix: " · Nym",
      deliveredViaHttpsSuffix: " · HTTPS",
      fileManageLabel: "Manage",
      fileReleaseLabel: "Release key",
      manageTitle: "Release file key",
      manageLoading: "Loading order...",
      manageError: "Could not load this order.",
      manageStatusLabel: "Status",
      secretMissingTitle: "Secret on another device",
      secretMissingBody:
        "This file was created on another device/browser. Open it there to release the key. Custody is seller-held: the key can only be released from the browser that created the file.",
    },
    send: {
      title: "Create paid private file",
      body: "Pick a file, set the ZEC price, and share a private link. The file is encrypted in your browser, so the server only ever holds ciphertext, and the key and file are delivered to the buyer over the Nym mixnet.",
      fileLabel: "Private file",
      chooseFileLabel: "Choose file",
      emptyFileLabel: "No file selected",
      priceLabel: "Price in ZEC",
      priceHint: "Example: 0.05 ZEC. The value is converted to zatoshis.",
      payoutAddressLabel: "Wallet to receive ZEC",
      payoutAddressPlaceholder: "u1...",
      payoutAddressHint:
        "The buyer pays an address derived from this account. Funds go straight to you.",
      noteLabel: "Note for buyer",
      notePlaceholder: "Optional",
      submitLabel: "Create paid private file",
      busyLabel: "Encrypting and creating link...",
      successTitle: "Private file ready",
      successBody:
        "Share the access link. The file unlocks only after the ZEC payment confirms on-chain, then is delivered over Nym and decrypted on the buyer's device.",
      copyLinkLabel: "Copy link",
      openLinkLabel: "Open link",
      shareWarningTitle: "Important",
      shareWarningBody:
        "Open this link in a different browser or device, not this one. The first browser to open the link becomes the buyer, and delivery over Nym needs two separate browsers. Sell one file at a time, and keep this tab open until the buyer confirms receipt.",
    },
    products: {
      supplyLabel: "Supply",
      supplyHint:
        "How many buyers can purchase this product. Unlimited sells with no cap; Limited sells out once the quantity is reached.",
      supplyOpenLabel: "Unlimited (open)",
      supplyLimitedLabel: "Limited",
      supplyMaxLabel: "Quantity",
      supplyMaxPlaceholder: "e.g. 10",
      supplyMaxInvalid: "Quantity must be a positive whole number.",
      submitLabel: "Create product",
      busyLabel: "Encrypting and creating product...",
      successTitle: "Product published",
      successBody:
        "Share the product link. Each buyer gets their own order; the file only opens after their ZEC payment is confirmed.",
      listTitle: "Your products",
      listEmptyTitle: "No products yet",
      listEmptyBody: "Create a product to sell the same file to many buyers.",
      listLoading: "Loading products...",
      copyLinkLabel: "Copy product link",
      linkCopiedLabel: "Link copied",
      supplyOpenSummary: "Open",
      supplyLimitedSummary: "{sold} / {max} sold",
      soldOutLabel: "Sold out",
      productBadge: "Product",
    },
    productBuy: {
      eyebrow: "Buy product",
      title: "Buy this private file",
      body: "Pay in ZEC and receive the file privately over a Nym session once your payment confirms.",
      loading: "Loading product...",
      errorTitle: "Product unavailable",
      errorBody:
        "This product was not found or is no longer for sale. Check the link with the seller.",
      supplyLimited: "{left} left",
      supplyOpen: "Available",
      soldOut: "Sold out",
      soldOutTitle: "Sold out",
      soldOutBody:
        "Every unit of this product has sold. Contact the seller about a new batch.",
      buyLabel: "Buy",
      buyingLabel: "Starting purchase...",
    },
    purchases: {
      title: "Purchases ({count})",
      emptyLabel: "No purchases yet",
      deliveringLabel: "Delivering over Nym...",
    },
    receive: {
      title: "Pay in ZEC, decrypt on your device",
      body: "Open the link and pay in ZEC. The key and file arrive over the Nym mixnet, and the file is decrypted on your device. A private receiver is set up automatically.",
      orderLabel: "Paid Private File",
      orderPlaceholder: "Paste file link or order id",
      nymAddressLabel: "Buyer Nym address",
      nymAddressPlaceholder: "nym...",
      nymAddressHint:
        "After payment, the decryption key and file are delivered to this address over the Nym mixnet.",
      startNymLabel: "Start Nym receiver",
      nymReadyLabel: "Nym receiver ready",
      nymStartingLabel: "Connecting Nym...",
      nymWaitingLabel: "Waiting for delivery over the Nym mixnet...",
      privateReceiverLabel: "Private receiver",
      privateReceiverBody:
        "Your browser sets up a Nym receiver automatically before payment, so the key and file arrive over the mixnet. Nothing to paste.",
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
      paymentAddressHint:
        "Your payment address + QR appear after you create the payment.",
      payHeadline: "Scan and pay to open",
      payHelper: "Scan the QR and pay in ZEC. That's it.",
      preparingPaymentLabel: "Preparing your payment...",
      detectedTitle: "Payment detected",
      detectedBody:
        "We saw your payment on the network and are waiting for it to confirm. You can keep this page open.",
      inTransitTitle: "Payment in transit",
      inTransitBody:
        "We received your payment and are confirming it. You can keep this page open.",
      copyAddressLabel: "Copy address",
      copyAddressDoneLabel: "Address copied",
      modalTitle: "Payment confirmed!",
      modalBody: "Download your file.",
      modalDownloadLabel: "Download file",
      modalPreparingLabel: "Preparing your file...",
      modalCloseLabel: "Close",
      doneTitle: "Done",
      doneBody:
        "Your file is ready and shown below. Tap Download to save it (or long-press the image).",
      receivingTitle: "Receiving your file...",
      receivingBody:
        "Payment confirmed. Your encrypted file is arriving over the Nym mixnet and will be decrypted on this device. Keep this page open.",
      arrivedTitle: "Your file arrived - saving it now.",
      arrivedBody:
        "The download should start on its own. If it doesn't, tap Save file.",
      saveFileLabel: "Save file",
      receivingOverNym: "Receiving encrypted file over Nym... {percent}%",
      receivedViaNym: "✓ Received over Nym (mixnet)",
      receivedViaHttps: "↩ Received over HTTPS (Nym fallback)",
    },
    buyerStatus: {
      title: "Your purchase status",
      stepAwaitingPayment: "Awaiting payment",
      stepAwaitingPaymentBody: "Scan the QR and pay in ZEC to open.",
      stepInTransit: "Payment detected",
      stepInTransitBody: "We received your payment and are confirming it.",
      stepPaid: "Paid",
      stepPaidBody: "Payment confirmed. Lining up your delivery over Nym.",
      stepReceivingKey: "Receiving key (Nym)",
      stepReceivingKeyBody:
        "The key and encrypted file are arriving over the Nym mixnet. Keep this tab open.",
      stepDone: "Done",
      stepDoneBody: "File received over Nym and decrypted on this device.",
      nymConnected: "Connected to Nym - listening for the key",
      nymConnecting: "Connecting to Nym...",
      nymNotConnected: "Not connected to Nym - try reconnecting",
      nymAddressLabel: "Your Nym address",
      reconnectNymLabel: "Reconnect Nym",
      keepTabOpenHint:
        "Keep this tab open. If it stalls, click Reconnect Nym - the seller re-sends the key automatically.",
      receiverStatusLabel: "Nym receiver",
      receiverAddressEmpty: "—",
      receiverEnvelopesLabel: "envelopes",
    },
    sellerStatus: {
      title: "Delivery status",
      stepAwaitingPayment: "Awaiting payment",
      stepPaid: "Paid",
      stepReleased: "Key released",
      stepSent: "Sent over Nym",
      stepDelivered: "Delivered to buyer",
      resendLabel: "Re-send key over Nym",
      resendingLabel: "Re-sending...",
      autoResendingLabel: "Re-sending over Nym...",
      deliveredToBuyer: "Delivered to buyer",
      notDeliveredYet:
        "Sent over Nym, waiting for the buyer to confirm receipt. Auto-resending while this screen stays open.",
      keepTabOpenHint:
        "Keep this screen open until it shows Delivered to buyer.",
      sendingOverNym: "Sending over Nym... {percent}%",
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
      privateDelivery: "Delivery over Nym",
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
      displayNameTaken: "That public name is already in use.",
    },
  },
};

export function getPaidPrivateFileCopy(
  locale: ProductLocale,
): PaidPrivateFileCopy {
  return COPY[locale];
}
