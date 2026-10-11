# KMP Publisher

Aplicação gráfica multiplataforma para preparar propostas de publicação para o
catálogo KMP. O desenvolvedor seleciona o ZIP e informa os dados do port. A
aplicação inspeciona o pacote, calcula seu SHA-256, valida o contrato e exporta
uma proposta reproduzível. Torrent, revisão editorial, assinatura e publicação
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
- geração de `submission.json` e cópia do pacote em `packages/`.

O envio autenticado ao GitHub e o acompanhamento da revisão serão adicionados
depois que o fluxo local for validado com autores de ports.

Veja [docs/PRODUCT.md](docs/PRODUCT.md) e
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
