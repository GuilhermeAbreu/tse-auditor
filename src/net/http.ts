export class HttpError extends Error {
  constructor(mensagem, { url, status, cause } = {}) {
    super(mensagem, { cause });
    this.name = 'HttpError';
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
  #pausadoAte = 0;

  constructor({
    concorrencia = 4,
    userAgent = 'tse-auditor',
    tentativas = 8,
    esperaBaseMs = 1000,
    esperaMaxMs = 60_000,
    timeoutMs = 120_000,
    fetchImpl = (...args) => fetch(...args),
    dormir = dormirPadrao,
    aleatorio = Math.random,
  } = {}) {
    if (!(concorrencia >= 1)) throw new RangeError('concorrencia deve ser >= 1');
    if (!(tentativas >= 1)) throw new RangeError('tentativas deve ser >= 1');
    this.#livres = concorrencia;
    Object.assign(this, { userAgent, tentativas, esperaBaseMs, esperaMaxMs, timeoutMs, fetchImpl, dormir, aleatorio });
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
    let minhaPausa = 0;
    for (let tentativa = 1; tentativa <= this.tentativas; tentativa++) {
      let esperaMs = this.aleatorio() * Math.min(this.esperaBaseMs * 2 ** (tentativa - 1), this.esperaMaxMs);
      await this.#adquirir();
      try {
        // pausa global causada por um 429 de outra requisição (a própria já espera esperaMs)
        const restante = this.#pausadoAte - Date.now();
        if (restante > 0 && this.#pausadoAte !== minhaPausa) await this.dormir(restante);
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
        if (resp.status === 429) {
          minhaPausa = Math.max(this.#pausadoAte, Date.now() + esperaMs);
          this.#pausadoAte = minhaPausa;
        }
        ultimoErro = new HttpError(`HTTP ${resp.status}`, { url, status: resp.status });
      } catch (err) {
        const raiz = err.cause?.code ?? err.cause?.message ?? err.message;
        ultimoErro = new HttpError(`falha de rede: ${raiz}`, { url, cause: err });
      } finally {
        this.#liberar();
      }
      if (tentativa < this.tentativas) await this.dormir(esperaMs);
    }
    throw new HttpError(`${ultimoErro.message} após ${this.tentativas} tentativas: ${url}`, {
      url,
      status: ultimoErro.status,
      cause: ultimoErro.cause,
    });
  }
}
