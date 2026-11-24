const services={yanzhou:'/health/yanzhou',linzhao:'/health/linzhao'};
async function check(name,url){const el=document.getElementById(name+'-status');try{const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error();el.textContent='在线';el.classList.add('ok');return true}catch{el.textContent='暂时离线';return false}}
Promise.all(Object.entries(services).map(([n,u])=>check(n,u))).then(results=>{document.getElementById('home-status').textContent=results.every(Boolean)?'双心港在线':'家仍在，部分房间连接中'});
