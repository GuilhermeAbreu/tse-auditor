export class HttpError extends Error {
  constructor(mensagem, { url, status } = {}) {
    super(mensagem);
    this.url = url;
    this.status = status;
  }
}

const retentavel = (status) => status === 429 || status >= 500;
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms));

// GET com limite de conexões simultâneas e espera progressiva em 429, 5xx e falhas de rede.
// Outros status (inclusive 404) voltam para quem chamou decidir.
export class HttpClient {
  #livres;
  #fila = [];

  constructor({
    concorrencia = 4,
    userAgent = 'tse-auditor',
    tentativas = 6,
    esperaBaseMs = 1000,
    esperaMaxMs = 60_000,
    timeoutMs = 120_000,
    fetchImpl = (...args) => fetch(...args),
    dormir = dormirPadrao,
  } = {}) {
    this.#livres = concorrencia;
    Object.assign(this, { userAgent, tentativas, esperaBaseMs, esperaMaxMs, timeoutMs, fetchImpl, dormir });
  }

  async #adquirir() {
    if (this.#livres > 0) {
      this.#livres--;
      return;
    }
    await new Promise((r) => this.#fila.push(r));
  }

  #liberar() {
    const proximo = this.#fila.shift();
    if (proximo) proximo();
    else this.#livres++;
  }

  async get(url) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= this.tentativas; tentativa++) {
      let esperaMs = Math.min(this.esperaBaseMs * 2 ** (tentativa - 1), this.esperaMaxMs);
      await this.#adquirir();
      try {
        const resp = await this.fetchImpl(url, {
          headers: { 'user-agent': this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!retentavel(resp.status)) {
          const body = Buffer.from(await resp.arrayBuffer());
          return { status: resp.status, body, etag: resp.headers.get('etag') };
        }
        await resp.arrayBuffer().catch(() => {});
        const retryAfter = Number(resp.headers.get('retry-after'));
        if (retryAfter > 0) esperaMs = Math.min(retryAfter * 1000, this.esperaMaxMs);
        ultimoErro = new HttpError(`HTTP ${resp.status}`, { url, status: resp.status });
      } catch (err) {
        ultimoErro = new HttpError(`falha de rede: ${err.message}`, { url });
      } finally {
        this.#liberar();
      }
      if (tentativa < this.tentativas) await this.dormir(esperaMs);
    }
    throw new HttpError(`${ultimoErro.message} após ${this.tentativas} tentativas: ${url}`, {
      url,
      status: ultimoErro.status,
    });
  }
}
