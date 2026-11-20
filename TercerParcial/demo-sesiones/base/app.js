// La aplicación de la demo. server.js la arranca; las pruebas la arrancan con otras configuraciones.
const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { crearModeloUsuarios } = require('./modelos/usuarios.modelo');
const crypto = require('crypto'); //para crear el id unico de cada token
const jwt = require('jsonwebtoken'); //libreria para firmar y verificar los JWT
const { crearModeloTokens } = require('./modelos/tokens.modelo'); //lista negra de tokens

const NOMBRE_COOKIE = 'connect.sid';

//Tenemos que determinar donde se deben de almacenar las sesiones para la aplicación si es en memoria, utilizamos MemoryStore (se pierde al reiniciar) y si la queremos guardar en MySQL debemos de obtenerla y mantenerla durante su ciclo de vida

function todasLasSesiones(almacen){
  return new Promise((resolve, reject)=>{
    const promesa = almacen.all((error, sesiones)=> (error ? reject(error) : resolve(sesiones)));
    if (promesa && typeof promesa.then === 'function') promesa.then(resolve, reject);
  });
}

//vamos a conectarnos a la aplicacion
function crearApp(config, pool){
  const app = express();
  //validacion: el json no puede pesar mas de 10kb
  app.use(express.json({ limit: '10kb' }));
  const usuarios = crearModeloUsuarios(pool);
  const tokens = crearModeloTokens(pool); //jwt: la tabla tokens_revocados

  //necesito crear una sesión a partir del tipo, rol y privilegio del usuario
  //opcion 1 manejarlo desde mysql, significa que debo de tener una tabla de sesiones
  //opcion 2 manejarlo desde memoria

  const almacen = config.almacen === 'memoria'
    ? new session.MemoryStore()
    : new MySQLStore({ createDatabaseTable: false, clearExpired: false }, pool);
  app.locals.almacen = almacen;

  app.use(
    session({
      //nosotros creamos la cookie para que vaya sobre todo el elemento de la aplicación
      name : NOMBRE_COOKIE,
      secret : process.env.SESSION_SECRET || 'secreto-solo-para-la-demo',
      store : almacen,
      resave : false,
      saveUninitialized : false, //no crea la sesion ni la cookie
      rolling : config.rolling,
      cookie : {
        maxAge: config.maxAgeMs,
        httpOnly: config.httpOnly,
        sameSite : config.sameSite,
        secure : false //activar el https
      }
    })
  );

  //conocer el id de la sesión
  const idCorto = (id) => (id ? `${id.slice(0, 8)}…` : null);

  //cuando estemos utilizando un middleware verificar la sesión actividad a partir ya sea de la consulta al servidor o la cookie
  function vencida(sesion){
    const desde = config.rolling ? sesion.ultimoUso : sesion.creada;
    return Date.now() - desde > config.maxAgeMs;
  }

  //tenemos que identicar quien entro
  function requiereSesion(req, res, next){
    if (req.session.usuario && vencida(req.session)){
      return req.session.destroy(() => {
        res.clearCookie(NOMBRE_COOKIE);
        res.status(401).json({error: '401 · Tu sesión venció: vuelve a iniciar sesión'});
      });
    }
    if(!req.session.usuario){
      return res.status(401).json({error: '401 · No has iniciado sesión (o tu sesión ya venció)'});
    }
    req.session.ultimoUso = Date.now();
    next();
  }

  //revisamos el rol del usuario, si no es el correcto 403
  function requiereRol(rol){
    return (req, res, next) => {
      if(req.session.usuario.rol !== rol){
        return res.status(403).json({error: `403 · Eres ${req.session.usuario.usuario}, pero esta ruta es solo para ${rol}`});
      }
      next();
    };
  }


  //validacion: contamos los intentos fallidos de login, si son 5 se bloquea un minuto
  const intentosFallidos = {};
  const MAX_INTENTOS = 5;
  const BLOQUEO_MS = 60 * 1000; //1 minuto

  function estaBloqueado(ip){
    const registro = intentosFallidos[ip];
    if(!registro) return false;
    if(registro.bloqueadoHasta && Date.now() < registro.bloqueadoHasta) return true;
    if(registro.bloqueadoHasta && Date.now() >= registro.bloqueadoHasta) delete intentosFallidos[ip]; //ya paso el minuto
    return false;
  }

  function sumarFallo(ip){
    const registro = intentosFallidos[ip] || { fallos: 0, bloqueadoHasta: null };
    registro.fallos += 1;
    if(registro.fallos >= MAX_INTENTOS) registro.bloqueadoHasta = Date.now() + BLOQUEO_MS;
    intentosFallidos[ip] = registro;
  }

  //validacion: revisamos que el usuario y la contraseña vengan bien
  function validarLogin(cuerpo){
    if(!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return 'Manda un JSON con usuario y contrasena';
    const {usuario, contrasena} = cuerpo;
    if(usuario === undefined || contrasena === undefined) return 'Faltan datos: se necesita usuario y contrasena';
    //tienen que ser texto
    if(typeof usuario !== 'string' || typeof contrasena !== 'string') return 'usuario y contrasena deben ser texto';
    if(usuario.trim() === '' || contrasena === '') return 'usuario y contrasena no pueden ir vacíos';
    if(usuario.length > 30) return 'El usuario no puede tener más de 30 caracteres';
    if(contrasena.length > 100) return 'La contraseña no puede tener más de 100 caracteres';
    //solo letras, numeros, punto y guiones
    if(!/^[a-zA-Z0-9._-]+$/.test(usuario.trim())) return 'El usuario solo puede tener letras, números, punto, guion o guion bajo';
    return null;
  }

  app.get('/api/config', (req, res) => res.json(config));

  //vamos a generar un contador en la sesion, sirve para saver que la sesion existe antes de entrar
  app.post('/api/visita', (req, res) =>{
    req.session.visitas = (req.session.visitas || 0)+1;
    res.json({visitas : req.session.visitas, sesion : idCorto(req.sessionID)});
  });

  //ruta para iniciar sesion
  app.post('/api/login', async(req, res, next)=>{
    try{
      //validacion: si ya fallo muchas veces lo bloqueamos
      if(estaBloqueado(req.ip)){
        return res.status(429).json({error: '429 · Demasiados intentos fallidos, espera un minuto'});
      }

      //validacion: si los datos vienen mal regresamos 400
      const problema = validarLogin(req.body);
      if(problema) return res.status(400).json({error: `400 · ${problema}`});

      const usuario = req.body.usuario.trim();
      const contrasena = req.body.contrasena;
      const datos = await usuarios.verificar(usuario, contrasena);
      //mismo mensaje si no existe el usuario o la contraseña esta mal
      if(!datos){
        sumarFallo(req.ip);
        return res.status(401).json({error: 'Usuario o contraseña incorrectos'});
      }
      delete intentosFallidos[req.ip]; //entro bien, borramos sus fallos

      //necesito crear su sesion
      const antes = req.session.visitas !== undefined ? idCorto(req.sessionID) : null;
      const visitas = req.session.visitas || 0;

      //guardo la sesion
      const guardar = () =>{
        req.session.usuario = datos;
        req.session.visitas = visitas;
        req.session.creada = Date.now();
        req.session.ultimoUso = Date.now();
        req.session.save((error)=>{
          if(error) return next(error);
          res.json({usuario:datos, sesionAntes: antes, sesionDespues: idCorto(req.sessionID)});
        });
      };

      if(config.regenerarAlEntrar){
        //se crea una nueva sesion y se descarta la anterior
        req.session.regenerate((error) => (error ? next(error) : guardar()));
      }else{
        guardar();
      }

    }catch(error){
      next(error);
    }
  });

  //cerrar sesion
  app.post('/api/logout', (req, res, next)=>{
    req.session.destroy((error)=>{
      if(error) return next(error);
      res.clearCookie(NOMBRE_COOKIE);
      res.json({mensaje: 'Sesión cerrada: el servidor la borró'});
    });
  });

  app.get('/api/sesion', requiereSesion, (req, res) =>{
    const desde = config.rolling ? req.session.ultimoUso : req.session.creada;
    res.json({
      usuario : req.session.usuario,
      sesion : idCorto(req.sessionID),
      expiraEnSegundos : Math.max(0, Math.round((desde + config.maxAgeMs - Date.now())/1000)),
    });
  });

  app.get('/api/perfil', requiereSesion, (req, res)=>{
    req.session.visitas = (req.session.visitas || 0)+1;
    res.json({mensaje : `Hola, ${req.session.usuario.nombre}`, rol : req.session.usuario.rol, visitas: req.session.visitas});
  });

  app.get('/api/admin/reporte', requiereSesion, requiereRol('admin'), (req, res)=>{
    res.json({reporte : 'Talleres: 3 · Inscritos: 57 · Cupo libre: 18'});
  });

  //vamos a simular que el servidor guarda la sesion y la expone, en productivo jamas se expone
  app.get('/api/diagnostico/sesiones', async(req, res, next)=>{
    try{
      const sesiones = await todasLasSesiones(almacen);
      const lista = Object.entries(sesiones || {}).map(([id, s]) =>({
        sesion : idCorto(id),
        esLaTuya : id === req.sessionID,
        usuario : s.usuario ? s.usuario.usuario : '(sin iniciar sesión)',
        visitas: s.visitas || 0,
        expira: s.cookie && s.cookie.expires,
      }));
      res.json({almacen: config.almacen, sesiones: lista});
    }catch(error){
      next(error);
    }
  });

  // ===================== JWT (semana 13) =====================
  //con jwt el servidor NO guarda la sesion, los datos del usuario viajan dentro del token
  //el navegador lo manda en el encabezado  Authorization: Bearer <token>

  //con que se firman los tokens, si cambia todos los tokens viejos dejan de servir
  const SECRETO_JWT = process.env.JWT_SECRET || 'secreto-jwt-solo-para-la-demo';

  //vamos a crear el token de un usuario, con datos (payload) + vencimiento + id unico y va a estar firmado con HS256
  function firmarToken(usuario){
    return jwt.sign(
      {sub: String(usuario.id), usuario: usuario.usuario, nombre: usuario.nombre, rol: usuario.rol},
      SECRETO_JWT,
      {algorithm: 'HS256', expiresIn: config.jwtExpiraSeg, jwtid: crypto.randomUUID()}
    );
  }

  //middleware: revisamos que venga el token y que sea valido
  async function requiereJWT(req, res, next){
    const encabezado = req.headers.authorization || '';
    if(!encabezado.startsWith('Bearer ')){
      return res.status(401).json({error: '401 · Falta el token (Authorization: Bearer ...)'});
    }
    const token = encabezado.slice('Bearer '.length).trim(); //quitamos el "Bearer " y nos quedamos con el token

    let datos;
    try{
      //solo aceptamos tokens firmados con HS256 y con nuestro secreto
      datos = jwt.verify(token, SECRETO_JWT, {algorithms: ['HS256']});
    }catch(error){
      if(error.name === 'TokenExpiredError'){
        return res.status(401).json({error: '401 · Token expirado, renuévalo o vuelve a iniciar sesión'});
      }
      return res.status(401).json({error: '401 · Token inválido'});
    }

    //si esta en la lista negra ya no lo dejamos pasar
    try{
      if(config.jwtRevocar && (await tokens.estaRevocado(datos.jti))){
        return res.status(401).json({error: '401 · Token revocado, ya se cerró la sesión'});
      }
    }catch(error){
      return next(error);
    }

    req.jwt = datos; //guardamos los datos del token para las rutas
    next();
  }

  //revisamos el rol que viene dentro del token, si no es el correcto 403
  function requiereRolJWT(rol){
    return (req, res, next) => {
      if(req.jwt.rol !== rol){
        return res.status(403).json({error: `403 · Eres ${req.jwt.usuario}, pero esta ruta es solo para ${rol}`});
      }
      next();
    };
  }

  //login con jwt: si el usuario y contraseña estan bien regresamos el token
  app.post('/api/jwt/login', async(req, res, next) =>{
    try{
      //usamos las mismas validaciones del login normal
      if(estaBloqueado(req.ip)){
        return res.status(429).json({error: '429 · Demasiados intentos fallidos, espera un minuto'});
      }
      const problema = validarLogin(req.body);
      if(problema) return res.status(400).json({error: `400 · ${problema}`});

      const datos = await usuarios.verificar(req.body.usuario.trim(), req.body.contrasena);
      if(!datos){
        sumarFallo(req.ip);
        return res.status(401).json({error: 'Usuario o contraseña incorrectos'});
      }
      delete intentosFallidos[req.ip];

      const token = firmarToken(datos);
      //no se crea cookie ni se guarda nada en el servidor, solo se regresa el token
      res.json({token, usuario: datos, expiraEnSegundos: config.jwtExpiraSeg});
    }catch(error){
      next(error);
    }
  });

  //los elementos de la "sesion" con jwt: lo que viene adentro del token
  app.get('/api/jwt/sesion', requiereJWT, (req, res)=>{
    res.json({
      usuario: {id: req.jwt.sub, usuario: req.jwt.usuario, nombre: req.jwt.nombre, rol: req.jwt.rol},
      jti: req.jwt.jti, //id unico del token
      emitido: new Date(req.jwt.iat * 1000), //cuando se creo
      expira: new Date(req.jwt.exp * 1000), //cuando vence
      expiraEnSegundos: Math.max(0, req.jwt.exp - Math.floor(Date.now() / 1000)),
    });
  });

  app.get('/api/jwt/perfil', requiereJWT, (req, res)=>{
    res.json({
      mensaje: `Hola, ${req.jwt.nombre}`,
      rol: req.jwt.rol,
      expiraEnSegundos: Math.max(0, req.jwt.exp - Math.floor(Date.now() / 1000)),
    });
  });

  //renovar: con un token que todavia sirve se crea uno nuevo con otros 5 minutos
  app.post('/api/jwt/refresh', requiereJWT, (req, res) => {
    const {sub, usuario, nombre, rol} = req.jwt;
    res.json({token: firmarToken({id: sub, usuario, nombre, rol}), expiraEnSegundos: config.jwtExpiraSeg});
  });

  app.get('/api/jwt/reporte', requiereJWT, requiereRolJWT('admin'), (req, res)=>{
    res.json({reporte: 'Talleres: 3 · Inscritos: 57 · Cupo libre: 18'});
  });

  //que le pasa al token cuando hacemos logout
  app.post('/api/jwt/logout', requiereJWT, async (req, res, next)=>{
    try{
      if(config.jwtRevocar){
        await tokens.revocar(req.jwt.jti, req.jwt.usuario, req.jwt.exp);
        return res.json({mensaje: 'Token revocado: el servidor lo anotó en la lista negra', revocado: true});
      }
      res.json({mensaje: 'El servidor no guarda nada, solo se borra el token del navegador (sigue sirviendo hasta que venza)', revocado: false});
    }catch(error){
      next(error);
    }
  });

  //solo para la clase: ver la lista negra, en productivo jamas se expone
  app.get('/api/diagnostico/tokens', async(req, res, next)=>{
    try{
      res.json({revocar: config.jwtRevocar, tokens: await tokens.listar()});
    }catch(error){
      next(error);
    }
  });

  app.use('/api', (req, res)=> res.status(404).json({error: '404 · Ruta no encontrada'}));

  app.use(express.static(path.join(__dirname, 'public')));

  app.use((error, req, res, next)=>{
    //validacion: si el json viene mal escrito regresamos 400
    if(error.type === 'entity.parse.failed'){
      return res.status(400).json({error: '400 · El JSON está mal escrito'});
    }
    //validacion: si es muy grande regresamos 413
    if(error.type === 'entity.too.large'){
      return res.status(413).json({error: '413 · Lo que mandaste es demasiado grande'});
    }
    console.log('Ejercicio de sesiones');
    console.error(error);
    //el error real solo se ve en la terminal
    res.status(500).json({error: '500 · Error del servidor'});
  });

  return app;
}

module.exports = {crearApp, NOMBRE_COOKIE};