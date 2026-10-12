# Produto: KMP Publisher

## Objetivo

Permitir que um desenvolvedor publique uma proposta de port sem conhecer o
formato do catálogo, BitTorrent, hashes ou o processo de assinatura. A
complexidade fica automatizada, mas cada resultado continua visível e
auditável.

## Princípios

1. **Poucos dados manuais:** detectar do ZIP tudo que puder ser determinado com
   segurança.
2. **Transparência:** mostrar arquivos, hash, requisitos, avisos e o estado da
   revisão antes de qualquer envio.
3. **Segurança:** nunca distribuir a chave editorial no Publisher.
4. **Reprodutibilidade:** a mesma entrada deve gerar a mesma submissão, exceto
   por datas explicitamente registradas.
5. **Multiplataforma:** o mesmo fluxo funciona em Windows, Linux e macOS.

## Jornada do desenvolvedor

1. Criar uma proposta.
2. Selecionar o ZIP do port.
3. Conferir raízes, launcher, tamanho e SHA-256 detectados.
4. Informar projeto, versão, autoria, licença e compatibilidade.
5. Corrigir erros e avaliar avisos.
6. Exportar ou enviar a proposta.
7. Acompanhar CI, revisão, alterações solicitadas e publicação.

## Responsabilidades automáticas

- inspeção segura do ZIP sem executar o port;
- cálculo do SHA-256;
- validação do contrato Publisher v1;
- auditoria de launchers, caminhos e arquivos executáveis;
- preparação da proposta e upload do pacote;
- criação de pull request;
- acompanhamento das verificações e da revisão.
- geração local do torrent para que o computador do autor se torne um seeder
  assim que exportar a proposta.

Depois da aprovação, a automação editorial valida e publica o mesmo torrent e
os destinos de web seed nele declarados, atualiza o snapshot, assina o head e
publica os mirrors.
Essas operações aparecem como
um único estado de publicação na GUI.

## Fora do Publisher

- posse ou uso da chave privada editorial;
- aprovação automática de licença ou redistribuição;
- assinatura direta do catálogo;
- execução silenciosa de arquivos contidos no port.

## Marcos

### v0.1 — proposta local

- GUI multiplataforma;
- inspeção do ZIP;
- formulário guiado;
- validação local;
- exportação de uma proposta compatível com o contrato atual.

### v0.2 — proposta no GitHub

- autenticação por Device Flow;
- criação de branch ou fork e pull request;
- upload controlado do pacote;
- acompanhamento do CI e comentários de revisão.
- ativação automática do seed ao exportar, com limite de upload, pausa e
  retomada visíveis na GUI.

### v0.3 — assistência editorial

- histórico de propostas;
- atualização de um port existente;
- comparação entre revisões;
- importação de metadados do PortMaster;
- prévia do card exibido no KMP Client.
