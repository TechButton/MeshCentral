

function parseServiceStatus(token) {
    var j = {};
    var serviceType = token.Deref(0, 4).IntVal;
    j.isFileSystemDriver = ((serviceType & 0x00000002) == 0x00000002);
    j.isKernelDriver = ((serviceType & 0x00000001) == 0x00000001);
    j.isSharedProcess = ((serviceType & 0x00000020) == 0x00000020);
    j.isOwnProcess = ((serviceType & 0x00000010) == 0x00000010);
    j.isInteractive = ((serviceType & 0x00000100) == 0x00000100);
    switch (token.Deref((1 * 4), 4).toBuffer().readUInt32LE()) {
        case 0x00000005:
            j.state = 'CONTINUE_PENDING';
            break;
        case 0x00000006:
            j.state = 'PAUSE_PENDING';
            break;
        case 0x00000007:
            j.state = 'PAUSED';
            break;
        case 0x00000004:
            j.state = 'RUNNING';
            break;
        case 0x00000002:
            j.state = 'START_PENDING';
            break;
        case 0x00000003:
            j.state = 'STOP_PENDING';
            break;
        case 0x00000001:
            j.state = 'STOPPED';
            break;
    }
    var controlsAccepted = token.Deref((2 * 4), 4).toBuffer().readUInt32LE();
    j.controlsAccepted = [];
    if ((controlsAccepted & 0x00000010) == 0x00000010) {
        j.controlsAccepted.push('SERVICE_CONTROL_NETBINDADD');
        j.controlsAccepted.push('SERVICE_CONTROL_NETBINDREMOVE');
        j.controlsAccepted.push('SERVICE_CONTROL_NETBINDENABLE');
        j.controlsAccepted.push('SERVICE_CONTROL_NETBINDDISABLE');
    }
    if ((controlsAccepted & 0x00000008) == 0x00000008) { j.controlsAccepted.push('SERVICE_CONTROL_PARAMCHANGE'); }
    if ((controlsAccepted & 0x00000002) == 0x00000002) { j.controlsAccepted.push('SERVICE_CONTROL_PAUSE'); j.controlsAccepted.push('SERVICE_CONTROL_CONTINUE'); }
    if ((controlsAccepted & 0x00000100) == 0x00000100) { j.controlsAccepted.push('SERVICE_CONTROL_PRESHUTDOWN'); }
    if ((controlsAccepted & 0x00000004) == 0x00000004) { j.controlsAccepted.push('SERVICE_CONTROL_SHUTDOWN'); }
    if ((controlsAccepted & 0x00000001) == 0x00000001) { j.controlsAccepted.push('SERVICE_CONTROL_STOP'); }
    if ((controlsAccepted & 0x00000020) == 0x00000020) { j.controlsAccepted.push('SERVICE_CONTROL_HARDWAREPROFILECHANGE'); }
    if ((controlsAccepted & 0x00000040) == 0x00000040) { j.controlsAccepted.push('SERVICE_CONTROL_POWEREVENT'); }
    if ((controlsAccepted & 0x00000080) == 0x00000080) { j.controlsAccepted.push('SERVICE_CONTROL_SESSIONCHANGE'); }
    j.pid = token.Deref((7 * 4), 4).toBuffer().readUInt32LE();
    return (j);
}

function serviceManager() {
    if (process.platform == 'win32') {
        this.GM = require('_GenericMarshal');
        this.proxy = this.GM.CreateNativeProxy('Advapi32.dll');
        this.proxy.CreateMethod('OpenSCManagerA');
        this.proxy.CreateMethod('EnumServicesStatusExA');
        this.proxy.CreateMethod('OpenServiceA');
        this.proxy.CreateMethod('QueryServiceStatusEx');
        this.proxy.CreateMethod('ControlService');
        this.proxy.CreateMethod('StartServiceA');
        this.proxy.CreateMethod('CloseServiceHandle');
        this.proxy.CreateMethod('CreateServiceA');
        this.proxy.CreateMethod('ChangeServiceConfig2A');
        this.proxy.CreateMethod('DeleteService');
        this.proxy.CreateMethod('AllocateAndInitializeSid');
        this.proxy.CreateMethod('CheckTokenMembership');
        this.proxy.CreateMethod('FreeSid');

        this.proxy2 = this.GM.CreateNativeProxy('Kernel32.dll');
        this.proxy2.CreateMethod('GetLastError');

        this.isAdmin = function isAdmin() {
            var NTAuthority = this.GM.CreateVariable(6);
            NTAuthority.toBuffer().writeInt8(5, 5);
            var AdministratorsGroup = this.GM.CreatePointer();
            var admin = false;

            if (this.proxy.AllocateAndInitializeSid(NTAuthority, 2, 32, 544, 0, 0, 0, 0, 0, 0, AdministratorsGroup).Val != 0) {
                var member = this.GM.CreateInteger();
                if (this.proxy.CheckTokenMembership(0, AdministratorsGroup.Deref(), member).Val != 0) {
                    if (member.toBuffer().readUInt32LE() != 0) { admin = true; }
                }
                this.proxy.FreeSid(AdministratorsGroup.Deref());
            }
            return admin;
        };
        this.getServiceFolder = function getServiceFolder() {
            var destinationFolder = null;
            if (require('os').arch() == 'x64') {
                // 64 bit Windows
                if (this.GM.PointerSize == 4) {
                    // 32 Bit App
                    destinationFolder = process.env['ProgramFiles(x86)'];
                } else {
                    // 64 bit App
                    destinationFolder = process.env['ProgramFiles'];
                }
            } else {
                // 32 bit Windows
                destinationFolder = process.env['ProgramFiles'];
            }
            return (destinationFolder + '\\Open Source\\MeshCmd');
        };

        this.enumerateService = function () {
            var machineName = this.GM.CreatePointer();
            var dbName = this.GM.CreatePointer();
            var handle = this.proxy.OpenSCManagerA(0x00, 0x00, 0x0001 | 0x0004);

            var bytesNeeded = this.GM.CreatePointer();
            var servicesReturned = this.GM.CreatePointer();
            var resumeHandle = this.GM.CreatePointer();
            //var services = this.proxy.CreateVariable(262144);
            var success = this.proxy.EnumServicesStatusExA(handle, 0, 0x00000030, 0x00000003, 0x00, 0x00, bytesNeeded, servicesReturned, resumeHandle, 0x00);
            if (bytesNeeded.IntVal <= 0) { throw('Error enumerating services'); }
            var sz = bytesNeeded.IntVal;
            var services = this.GM.CreateVariable(sz);
            this.proxy.EnumServicesStatusExA(handle, 0, 0x00000030, 0x00000003, services, sz, bytesNeeded, servicesReturned, resumeHandle, 0x00);
            console.log("servicesReturned", servicesReturned.IntVal);

            var ptrSize = dbName._size;
            var blockSize = 36 + (2 * ptrSize);
            blockSize += ((ptrSize - (blockSize % ptrSize)) % ptrSize);
            var retVal = [];
            for (var i = 0; i < servicesReturned.IntVal; ++i) {
                var token = services.Deref(i * blockSize, blockSize);
                var j = {};
                j.name = token.Deref(0, ptrSize).Deref().String;
                j.displayName = token.Deref(ptrSize, ptrSize).Deref().String;
                j.status = parseServiceStatus(token.Deref(2 * ptrSize, 36));
                retVal.push(j);
            }
            this.proxy.CloseServiceHandle(handle);
            return (retVal);
        }
        this.getService = function (name) {
            var serviceName = this.GM.CreateVariable(name);
            var ptr = this.GM.CreatePointer();
            var bytesNeeded = this.GM.CreateVariable(ptr._size);
            var handle = this.proxy.OpenSCManagerA(0x00, 0x00, 0x0001 | 0x0004 | 0x0020 | 0x0010);
            if (handle.Val == 0) { throw('Could not open ServiceManager'); }
            var h = this.proxy.OpenServiceA(handle, serviceName, 0x0004 | 0x0020 | 0x0010 | 0x00010000);
            if (h.Val != 0) {
                var success = this.proxy.QueryServiceStatusEx(h, 0, 0, 0, bytesNeeded);
                var status = this.GM.CreateVariable(bytesNeeded.toBuffer().readUInt32LE());
                success = this.proxy.QueryServiceStatusEx(h, 0, status, status._size, bytesNeeded);
                if (success != 0) {
                    retVal = {};
                    retVal.status = parseServiceStatus(status);
                    retVal._scm = handle;
                    retVal._service = h;
                    retVal._GM = this.GM;
                    retVal._proxy = this.proxy;
                    require('events').inherits(retVal);
                    retVal.on('~', function () { this._proxy.CloseServiceHandle(this); this._proxy.CloseServiceHandle(this._scm); });
                    retVal.name = name;
                    retVal.stop = function () {
                        if (this.status.state == 'RUNNING') {
                            var newstate = this._GM.CreateVariable(36);
                            var success = this._proxy.ControlService(this._service, 0x00000001, newstate);
                            if (success == 0) {
                                throw (this.name + '.stop() failed');
                            }
                        }
                        else {
                            throw ('Cannot call ' + this.name + '.stop(), when current state is: ' + this.status.state);
                        }
                    }
                    retVal.start = function () {
                        if (this.status.state == 'STOPPED') {
                            var success = this._proxy.StartServiceA(this._service, 0, 0);
                            if (success == 0) { throw (this.name + '.start() failed'); }
                        } else {
                            throw ('Cannot call ' + this.name + '.start(), when current state is: ' + this.status.state);
                        }
                    }
                    return (retVal);
                } else {

                }
            }

            this.proxy.CloseServiceHandle(handle);
            throw ('Could not find service: ' + name);
        }
    }
    this.installService = function installService(options) {
        if (process.platform == 'win32') {
            if (!this.isAdmin()) { throw ('Installing as Service, requires administrator permissions.'); }

            // Before we start, we need to copy the binary to the right place
            var folder = this.getServiceFolder();
            if (!require('fs').existsSync(folder)) { require('fs').mkdirSync(folder); }
            require('fs').copyFileSync(options.servicePath, folder + '\\' + options.name + '.exe');
            options.servicePath = folder + '\\' + options.name + '.exe';
            console.log('Installing to "' + options.servicePath + '"');

            var servicePath = this.GM.CreateVariable('"' + options.servicePath + '"');
            var handle = this.proxy.OpenSCManagerA(0x00, 0x00, 0x0002);
            if (handle.Val == 0) { throw ('Error opening SCManager'); }
            var serviceName = this.GM.CreateVariable(options.name);
            var displayName = this.GM.CreateVariable(options.name);
            var allAccess = 0x000F01FF;
            var serviceType;


            switch (options.startType) {
                case 'BOOT_START':
                    serviceType = 0x00;
                    break;
                case 'SYSTEM_START':
                    serviceType = 0x01;
                    break;
                case 'AUTO_START':
                    serviceType = 0x02;
                    break;
                case 'DEMAND_START':
                    serviceType = 0x03;
                    break;
                default:
                    serviceType = 0x04; // Disabled
                    break;
            }

            var h = this.proxy.CreateServiceA(handle, serviceName, displayName, allAccess, 0x10 | 0x100, serviceType, 0, servicePath, 0, 0, 0, 0, 0);
            if (h.Val == 0) { this.proxy.CloseServiceHandle(handle); throw ('Error Creating Service: ' + this.proxy2.GetLastError().Val); }
            if (options.description) {
                console.log(options.description);

                var dscPtr = this.GM.CreatePointer();
                dscPtr.Val = this.GM.CreateVariable(options.description);

                if (this.proxy.ChangeServiceConfig2A(h, 1, dscPtr) == 0) {
                    this.proxy.CloseServiceHandle(h);
                    this.proxy.CloseServiceHandle(handle);
                    throw ('Unable to set description');
                }
            }
            this.proxy.CloseServiceHandle(h);
            this.proxy.CloseServiceHandle(handle);
            return (this.getService(options.name));
        }
        if (process.platform == 'linux') {
            switch (this.getServiceType()) {
                case 'init':
                    require('fs').copyFileSync(options.servicePath, '/etc/init.d/' + options.name);
                    console.log('Copying ' + options.servicePath);
                    var m = require('fs').statSync('/etc/init.d/' + options.name).mode;
                    m |= (require('fs').CHMOD_MODES.S_IXUSR | require('fs').CHMOD_MODES.S_IXGRP);
                    require('fs').chmodSync('/etc/init.d/' + options.name, m);
                    this._update = require('child_process').execFile('/bin/sh', ['sh'], { type: require('child_process').SpawnTypes.TERM });
                    this._update._moduleName = options.name;
                    this._update.on('exit', function onUpdateRC_d() { console.log(this._moduleName + ' installed'); process.exit(); });
                    this._update.stdout.on('data', function (chunk) { });
                    this._update.stdin.write('update-rc.d ' + options.name + ' defaults\n');
                    this._update.stdin.write('exit\n');
                    //update-rc.d meshagent defaults # creates symlinks for rc.d
                    //service meshagent start

                    break;
                case 'systemd':
                    var serviceDescription = options.description ? options.description : 'MeshCentral Agent';
                    if (!require('fs').existsSync('/usr/local/mesh')) { require('fs').mkdirSync('/usr/local/mesh'); }
                    require('fs').copyFileSync(options.servicePath, '/usr/local/mesh/' + options.name);
                    var m = require('fs').statSync('/usr/local/mesh/' + options.name).mode;
                    m |= (require('fs').CHMOD_MODES.S_IXUSR | require('fs').CHMOD_MODES.S_IXGRP);
                    require('fs').chmodSync('/usr/local/mesh/' + options.name, m);
                    require('fs').writeFileSync('/lib/systemd/system/' + options.name + '.service', '[Unit]\nDescription=' + serviceDescription + '\n[Service]\nExecStart=/usr/local/mesh/' + options.name + '\nStandardOutput=null\nRestart=always\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\nAlias=' + options.name + '.service\n', { flags: 'w' });
                    this._update = require('child_process').execFile('/bin/sh', ['sh'], { type: require('child_process').SpawnTypes.TERM });
                    this._update._moduleName = options.name;
                    this._update.on('exit', function onUpdateRC_d() { console.log(this._moduleName + ' installed'); process.exit(); });
                    this._update.stdout.on('data', function (chunk) { });
                    this._update.stdin.write('systemctl enable ' + options.name + '.service\n');
                    this._update.stdin.write('exit\n');

                    break;
                default: // unknown platform service type
                    break;
            }
        }
    }
    this.uninstallService = function uninstallService(name) {
        if (typeof (name) == 'object') { name = name.name; }
        if (process.platform == 'win32') {
            if (!this.isAdmin()) { throw ('Uninstalling a service, requires administrator permissions.'); }

            var service = this.getService(name);
            if (service.status.state == undefined || service.status.state == 'STOPPED') {
                if (this.proxy.DeleteService(service._service) == 0) {
                    throw ('Uninstall Service for: ' + name + ', failed with error: ' + this.proxy2.GetLastError());
                } else {
                    try { require('fs').unlinkSync(this.getServiceFolder() + '\\' + name + '.exe'); } catch (e) { }
                }
            }
            else {
                throw ('Cannot uninstall service: ' + name + ', because it is: ' + service.status.state);
            }
        }
        else if (process.platform == 'linux') {
            switch (this.getServiceType()) {
                case 'init':
                    this._update = require('child_process').execFile('/bin/sh', ['sh'], { type: require('child_process').SpawnTypes.TERM });
                    this._update._svcname = name;
                    this._update.on('exit', function onUninstallExit() {
                        try {
                            require('fs').unlinkSync('/etc/init.d/' + this._svcname);
                            console.log(this._svcname + ' uninstalled');
                        } catch (e) { console.log(this._svcname + ' could not be uninstalled'); }
                        process.exit();
                    });
                    this._update.stdout.on('data', function (chunk) { });
                    this._update.stdin.write('service ' + name + ' stop\n');
                    this._update.stdin.write('update-rc.d -f ' + name + ' remove\n');
                    this._update.stdin.write('exit\n');
                    break;
                case 'systemd':
                    this._update = require('child_process').execFile('/bin/sh', ['sh'], { type: require('child_process').SpawnTypes.TERM });
                    this._update._svcname = name;
                    this._update.on('exit', function onUninstallExit() {
                        try {
                            require('fs').unlinkSync('/usr/local/mesh/' + this._svcname);
                            require('fs').unlinkSync('/lib/systemd/system/' + this._svcname + '.service');
                            console.log(this._svcname + ' uninstalled');
                        } catch (e) { console.log(this._svcname + ' could not be uninstalled'); }
                        process.exit();
                    });
                    this._update.stdout.on('data', function (chunk) { });
                    this._update.stdin.write('systemctl stop ' + name + '.service\n');
                    this._update.stdin.write('systemctl disable ' + name + '.service\n');
                    this._update.stdin.write('exit\n');
                    break;
                default: // unknown platform service type
                    break;
            }
        }
    }
    if (process.platform == 'linux') {
        this.getServiceType = function getServiceType() {
            return (require('processManager').getProcessInfo(1).Name);
        };
    }
}

module.exports = serviceManager;