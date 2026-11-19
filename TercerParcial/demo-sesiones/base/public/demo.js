// La página solo hace peticiones a la API. El navegador manda la cookie sola porque la página y el servidor son el mismo.
// El script va al final del body, así que todos los elementos ya existen cuando se ejecuta.

// Atajo: $('id') regresa el elemento con ese id.
const $ = (id) => document.getElementById(id);

// Hace una petición al servidor y regresa el código de respuesta y los datos.
// Así no tenemos que repetir fetch en cada botón.
async function llamar(metodo, url, cuerpo) {
  const opciones = { method: metodo, headers: {} };
  // Si mandamos datos, avisamos que son JSON para que express.json() los pueda leer.
  if (cuerpo !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(cuerpo);
  }
  let respuesta;
  try {
    respuesta = await fetch(url, opciones);
  } catch {
    // Si el servidor está apagado, fetch truena. Regresamos un código 0 para que la página no se rompa.
    return { status: 0, datos: { error: 'No hay conexión con el servidor (¿está corriendo npm start?)' } };
  }
  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null; // si la respuesta no es JSON, dejamos null
  }
  return { status: respuesta.status, datos };
}

// Regresa la clase CSS del color según el código: verde para éxito, amarillo para 401, rojo para lo demás.
function claseDelCodigo(status) {
  if (status >= 200 && status < 300) return 'codigo ok';
  if (status === 401) return 'codigo e401';
  if (status === 403) return 'codigo e403';
  return 'codigo error';
}

// Agrega una fila arriba de la bitácora con el código, la ruta y la respuesta.
// Usamos textContent y no innerHTML para que nadie pueda meter código HTML o un script.
function anotar(metodo, url, status, datos) {
  const li = document.createElement('li');

  const codigo = document.createElement('span');
  codigo.className = claseDelCodigo(status);
  codigo.textContent = status;

  const ruta = document.createElement('span');
  ruta.textContent = ` ${metodo} ${url}`;

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(datos, null, 2);

  li.append(codigo, ruta, pre);
  $('bitacora').prepend(li);

  // La bitácora solo guarda las últimas 30 filas para que la página no se ponga lenta.
  const lista = $('bitacora');
  while (lista.children.length > 30) lista.lastElementChild.remove();
}

// Revisa el formulario antes de mandarlo al servidor. Regresa el mensaje de error o null si todo está bien.
function validarFormulario(usuario, contrasena) {
  if (usuario.trim() === '') return 'Escribe un usuario';
  if (contrasena === '') return 'Escribe la contraseña';
  if (usuario.length > 30) return 'El usuario es demasiado largo';
  if (contrasena.length > 100) return 'La contraseña es demasiado larga';
  return null;
}

// Apaga o prende todos los botones. Se apagan mientras el servidor responde para que no se les pique varias veces.
function bloquearBotones(bloquear) {
  document.querySelectorAll('button').forEach((b) => { b.disabled = bloquear; });
}

// Pregunta al servidor si hay sesión y muestra el resultado en la página.
// También muestra la cookie que puede leer JavaScript (con HttpOnly sale vacía).
async function pintarEstado() {
  const { status, datos } = await llamar('GET', '/api/sesion');
  const estado = $('estado');
  if (status === 200 && datos && datos.usuario) {
    const u = datos.usuario;
    estado.textContent = `Con sesión: ${u.nombre} (${u.rol}) · sesión ${datos.sesion} · vence en ${datos.expiraEnSegundos} s`;
    estado.className = 'estado con-sesion';
  } else {
    estado.textContent = `Sin sesión (el servidor responde ${status})`;
    estado.className = 'estado sin-sesion';
  }
  // Con httpOnly en true sale vacío, porque JavaScript no puede leer la cookie.
  $('cookie-js').textContent = document.cookie || '(vacío)';
}

// Pide al servidor la lista de sesiones guardadas y la pone en la tabla.
// Primero vacía la tabla para que las filas no se dupliquen.
async function pintarTabla() {
  const { status, datos } = await llamar('GET', '/api/diagnostico/sesiones');
  const tbody = $('tabla-sesiones');
  tbody.replaceChildren();

  // Si el servidor no respondió bien, avisamos y ponemos una fila de error.
  if (status !== 200 || !datos) {
    $('donde').textContent = `No se pudo leer el diagnóstico (código ${status})`;
    agregarFilaVacia(tbody, '(no se pudo leer)');
    return;
  }

  // Decimos dónde están guardadas las sesiones: en memoria o en MySQL.
  $('donde').textContent = datos.almacen === 'memoria'
    ? 'En la MEMORIA del servidor (MemoryStore): se pierden al reiniciar'
    : 'En MySQL, tabla sessions (sobreviven a un reinicio)';

  if (!datos.sesiones || datos.sesiones.length === 0) {
    agregarFilaVacia(tbody, '(sin sesiones)');
    return;
  }

  // Una fila por sesión. La tuya se marca con otro color.
  for (const s of datos.sesiones) {
    const tr = document.createElement('tr');
    if (s.esLaTuya) tr.className = 'tuya';
    const vence = s.expira ? new Date(s.expira).toLocaleTimeString() : '—'; // hora local
    const celdas = [
      s.esLaTuya ? `${s.sesion} (la tuya)` : s.sesion,
      s.usuario,
      String(s.visitas),
      vence,
    ];
    for (const texto of celdas) {
      const td = document.createElement('td');
      td.textContent = texto;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

// Agrega una fila de la tabla con un solo mensaje, por ejemplo "(sin sesiones)".
function agregarFilaVacia(tbody, texto) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.textContent = texto;
  tr.append(td);
  tbody.append(tr);
}

// Actualiza el estado y la tabla al mismo tiempo.
async function refrescarTodo() {
  await pintarEstado();
  await pintarTabla();
}

// Evento: al enviar el formulario de login. Evitamos que la página se recargue y mandamos los datos al servidor.
$('form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const cuerpo = { usuario: $('usuario').value, contrasena: $('contrasena').value };
  const problema = validarFormulario(cuerpo.usuario, cuerpo.contrasena);
  if (problema) {
    // Si el formulario tiene un error, no mandamos nada: solo lo anotamos en la bitácora.
    anotar('POST', '/api/login', '--', { error: `La página no lo mandó: ${problema}` });
    return;
  }
  bloquearBotones(true);
  try {
    const { status, datos } = await llamar('POST', '/api/login', cuerpo);
    anotar('POST', '/api/login', status, datos);
    await refrescarTodo();
  } finally {
    bloquearBotones(false); // los botones se activan otra vez aunque algo falle
  }
});

// Evento: al cambiar el usuario, ponemos su contraseña de ejemplo (usuario + 12345).
$('usuario').addEventListener('change', () => {
  $('contrasena').value = `${$('usuario').value}12345`;
});

// Evento: cada botón con data-url hace su petición (método y ruta) y luego refresca la página.
document.querySelectorAll('button[data-url]').forEach((boton) => {
  boton.addEventListener('click', async () => {
    const { metodo, url } = boton.dataset;
    bloquearBotones(true);
    try {
      const { status, datos } = await llamar(metodo, url);
      anotar(metodo, url, status, datos);
      await refrescarTodo();
    } finally {
      bloquearBotones(false);
    }
  });
});

// Evento: los botones de refrescar y de sesiones.
$('btn-refrescar').addEventListener('click', refrescarTodo);
$('btn-sesiones').addEventListener('click', pintarTabla);

// Al cargar la página: mostramos la configuración del servidor y llenamos el estado y la tabla.
async function iniciar() {
  $('contrasena').maxLength = 100; // límite de 100 caracteres en la contraseña
  const { datos } = await llamar('GET', '/api/config');
  $('config').textContent = JSON.stringify(datos, null, 2);
  await refrescarTodo();
}
iniciar();