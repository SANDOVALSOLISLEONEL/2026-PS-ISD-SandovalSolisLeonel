
// La página solo hace fetch a la API. El navegador manda la cookie solo (misma página, mismo servidor).
//el script esta al final del body, entonces ya existen todos los elementos cuando corre
const $ = (id) => document.getElementById(id);
 
//Etapa 1: funcion para llamar a la api, la usamos en todas las peticiones
//fetch no marca error con 401 o 403, el codigo lo sacamos de respuesta.status
//no necesitamos credentials: 'include' porque la pagina y la api estan en el mismo servidor
async function llamar(metodo, url, cuerpo) {
  const opciones = { method: metodo, headers: {} };
  //si hay cuerpo mandamos el content-type para que express.json() lo pueda leer
  if (cuerpo !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(cuerpo);
  }
  let respuesta;
  try {
    respuesta = await fetch(url, opciones);
  } catch {
    //validacion: si el servidor esta apagado regresamos codigo 0 para que no truene la pagina
    return { status: 0, datos: { error: 'No hay conexión con el servidor (¿está corriendo npm start?)' } };
  }
  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null; //si no viene json lo dejamos en null
  }
  return { status: respuesta.status, datos };
}
 
//Etapa 2: la bitacora
//elegimos el color segun el codigo de respuesta
function claseDelCodigo(status) {
  if (status >= 200 && status < 300) return 'codigo ok';
  if (status === 401) return 'codigo e401';
  if (status === 403) return 'codigo e403';
  return 'codigo error';
}
 
//agregamos cada respuesta arriba con prepend
//usamos textContent y no innerHTML para evitar XSS (que metan un script)
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
 
  //validacion: solo dejamos las ultimas 30 para que la pagina no se haga lenta
  const lista = $('bitacora');
  while (lista.children.length > 30) lista.lastElementChild.remove();
}
 
//validacion: revisamos el formulario antes de mandarlo al servidor
function validarFormulario(usuario, contrasena) {
  if (usuario.trim() === '') return 'Escribe un usuario';
  if (contrasena === '') return 'Escribe la contraseña';
  if (usuario.length > 30) return 'El usuario es demasiado largo';
  if (contrasena.length > 100) return 'La contraseña es demasiado larga';
  return null;
}
 
//validacion: desactivamos los botones mientras responde el servidor para que no le piquen muchas veces
function bloquearBotones(bloquear) {
  document.querySelectorAll('button').forEach((b) => { b.disabled = bloquear; });
}
 
//Etapa 3: el estado, le preguntamos al servidor si tenemos sesion
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
  //con httpOnly en true sale vacio porque javascript no puede leer la cookie
  $('cookie-js').textContent = document.cookie || '(vacío)';
}
 
//Etapa 4: la tabla de sesiones que guarda el servidor
//primero vaciamos el tbody para que no se dupliquen las filas
async function pintarTabla() {
  const { status, datos } = await llamar('GET', '/api/diagnostico/sesiones');
  const tbody = $('tabla-sesiones');
  tbody.replaceChildren();
 
  if (status !== 200 || !datos) {
    $('donde').textContent = `No se pudo leer el diagnóstico (código ${status})`;
    agregarFilaVacia(tbody, '(no se pudo leer)');
    return;
  }
 
  $('donde').textContent = datos.almacen === 'memoria'
    ? 'En la MEMORIA del servidor (MemoryStore): se pierden al reiniciar'
    : 'En MySQL, tabla sessions (sobreviven a un reinicio)';
 
  if (!datos.sesiones || datos.sesiones.length === 0) {
    agregarFilaVacia(tbody, '(sin sesiones)');
    return;
  }
 
  for (const s of datos.sesiones) {
    const tr = document.createElement('tr');
    if (s.esLaTuya) tr.className = 'tuya';
    const vence = s.expira ? new Date(s.expira).toLocaleTimeString() : '—'; //fecha a hora local
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
 
//fila de cuando no hay sesiones
function agregarFilaVacia(tbody, texto) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.textContent = texto;
  tr.append(td);
  tbody.append(tr);
}
 
//refresca el estado y la tabla juntos
async function refrescarTodo() {
  await pintarEstado();
  await pintarTabla();
}
 
//Etapa 5: los eventos
//formulario de login, preventDefault para que no se recargue la pagina
$('form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const cuerpo = { usuario: $('usuario').value, contrasena: $('contrasena').value };
  const problema = validarFormulario(cuerpo.usuario, cuerpo.contrasena);
  if (problema) {
    //no se manda al servidor, solo lo anotamos con --
    anotar('POST', '/api/login', '--', { error: `La página no lo mandó: ${problema}` });
    return;
  }
  bloquearBotones(true);
  try {
    const { status, datos } = await llamar('POST', '/api/login', cuerpo);
    anotar('POST', '/api/login', status, datos);
    await refrescarTodo();
  } finally {
    bloquearBotones(false); //se vuelven a activar aunque falle algo
  }
});
 
//cuando cambia el usuario ponemos su contraseña de ejemplo
$('usuario').addEventListener('change', () => {
  $('contrasena').value = `${$('usuario').value}12345`;
});
 
//recorremos todos los botones que tienen data-url, el metodo y la url los sacamos con dataset
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
 
$('btn-refrescar').addEventListener('click', refrescarTodo);
$('btn-sesiones').addEventListener('click', pintarTabla);
 
//Etapa 6: al cargar la pagina mostramos la configuracion y refrescamos todo
async function iniciar() {
  //validacion: maximo 100 caracteres en la contraseña
  $('contrasena').maxLength = 100;
  const { datos } = await llamar('GET', '/api/config');
  $('config').textContent = JSON.stringify(datos, null, 2);
  await refrescarTodo();
}
iniciar();