# KMP Publisher

Aplicação gráfica multiplataforma para preparar propostas de publicação para o
catálogo KMP. O desenvolvedor seleciona o ZIP e informa os dados do port. A
aplicação inspeciona o pacote, calcula seu SHA-256, valida o contrato e exporta
uma proposta reproduzível. Revisão editorial, assinatura e publicação
são executados posteriormente pela automação segura do KMP Catalog.

## Plataformas

- Windows: instalador NSIS;
- Linux: AppImage;
- macOS: DMG.

## Desenvolvimento

Requer Node.js 22 ou mais recente.

```sh
npm install
npm test
npm start
```

Para criar o instalador da plataforma atual:

```sh
npm run package
```

## Estado da v0.1

A primeira implementação oferece:

- seleção de um ZIP;
- SHA-256 e inspeção segura da estrutura;
- detecção de launchers e raízes de instalação;
- formulário para metadados, compatibilidade e licença;
- validação antes da exportação;
- geração de `submission.json`, cópia do pacote em `packages/` e torrent em
  `torrents/`;
- geração determinística do torrent durante a exportação e início imediato da
  semeação pelo computador do desenvolvedor;
- confirmação posterior de que o catálogo publicou exatamente o mesmo torrent.
- conexão protegida com o GitHub e abertura automática de pull request com a
  proposta, o pacote e o torrent para revisão editorial.

## Publicação no GitHub

Na primeira publicação, conecte uma conta usando um token de acesso do GitHub
com permissão de conteúdo e pull requests no `KMP-catalog`. Quando o cofre
criptográfico do sistema estiver disponível, a credencial é armazenada por ele;
ela nunca é incluída na proposta ou enviada ao catálogo. O Publisher cria ou
reutiliza o fork da conta, abre uma branch e envia a proposta para revisão.

O envio autenticado ao GitHub e o acompanhamento da revisão serão adicionados
depois que o fluxo local for validado com autores de ports.

Veja [docs/PRODUCT.md](docs/PRODUCT.md) e
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
