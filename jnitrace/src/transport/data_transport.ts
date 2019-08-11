import { JNIThreadManager } from "../jni/jni_thread_manager";

import { Types }  from "../utils/types";
import { MethodData } from "../utils/method_data";
import { Config } from "../utils/config";
import { JNIMethod } from "../jni/jni_method";

const JNI_OK = 0;
const TYPE_NAME_START = 0;
const TYPE_NAME_END = -1;
const SKIP_ENV_INDEX = 1;
const EMPTY_ARRAY_LEN = 0;


class NativeMethodJSONContainer {
    public readonly name: { [id: string]: string | null };
    public readonly sig: { [id: string]: string | null };
    public readonly addr: { [id: string]: string };

    public constructor(
        name: { [id: string]: string | null },
        sig: { [id: string]: string | null },
        addr: { [id: string]: string }
    ) {
        this.name = name;
        this.sig = sig;
        this.addr = addr;
    }
};

/* eslint-disable @typescript-eslint/camelcase */
class DataJSONContainer {
    public readonly value: NativeArgumentValue | NativeReturnValue;
    public readonly data: ArrayBuffer | NativeArgumentValue | NativeReturnValue
    | string | NativeMethodJSONContainer[] | undefined;
    public readonly data_for: number | undefined;
    public readonly has_data: boolean | undefined;

    public constructor(
        value: NativeArgumentValue | NativeReturnValue,
        data: ArrayBuffer | NativeArgumentValue | NativeReturnValue
        | string | NativeMethodJSONContainer[] | null,
        dataIndex? : number
    ) {
        const RET_INDEX = -1;
        this.value = value;

        if (data !== null) {
            if (!(data instanceof ArrayBuffer)) {
                this.data = data;
            }
        }

        if (dataIndex !== undefined) {
            if (dataIndex === RET_INDEX) {
                this.has_data = true;
            } else {
                this.data_for = dataIndex;
            }
        }
    }
};

class BacktraceJSONContainer {
    public readonly address: NativePointer;
    public readonly module: Module | null;

    public constructor(address: NativePointer, module: Module | null) {
        this.address = address;
        this.module = module;
    }
};

class RecordJSONContainer {
    public readonly type: string;
    public readonly call_type: string;
    public readonly method: JNIMethod;
    public readonly args: DataJSONContainer[];
    public readonly ret: DataJSONContainer;
    public readonly thread_id: number;
    public readonly timestamp: number;

    public readonly java_params: string[] | undefined;
    public readonly backtrace: BacktraceJSONContainer[] | undefined;

    public constructor(
        callType: string,
        method: JNIMethod,
        args: DataJSONContainer[],
        ret: DataJSONContainer,
        threadId: number,
        timestamp: number,
        javaParams?: string[],
        backtrace?: BacktraceJSONContainer[]
    ) {
        this.type = "trace_data";
        this.call_type = callType;
        this.method = method;
        this.args = args;
        this.ret = ret;
        this.thread_id = threadId;
        this.timestamp = timestamp;
        this.java_params = javaParams;
        this.backtrace = backtrace;
    }
};
/* eslint-enable @typescript-eslint/camelcase */

class DataTransport {
    private readonly threads: JNIThreadManager;
    private readonly start: number;
    private readonly byteArraySizes: { [id: string]: number };

    public constructor(threads: JNIThreadManager) {
        this.threads = threads;
        this.start = Date.now();
        this.byteArraySizes = {};
    }

    public reportJavaVMCall(
        data: MethodData,
        context: CpuContext | NativePointer[]
    ): void {
        const config = Config.getInstance();
        const outputArgs: DataJSONContainer[] = [];
        const outputRet: DataJSONContainer = new DataJSONContainer(
            data.ret, null
        );
        const javaVM = this.threads.getJavaVM();

        if (!config.vm || this.shouldIgnoreMethod(data)) {
            return;
        }

        outputArgs.push(new DataJSONContainer(javaVM, null));

        const sendData = this.addJavaVMArgs(data, outputArgs);

        this.sendToHost(
            "JavaVM",
            data,
            outputArgs,
            outputRet,
            sendData,
            context
        );
    }

    public reportJNIEnvCall(
        data: MethodData,
        context: CpuContext | NativePointer[]
    ): void {
        const RET_INDEX = 0;
        const config = Config.getInstance();
        const threadId = Process.getCurrentThreadId();
        const outputArgs: DataJSONContainer[] = [];
        const outputRet: DataJSONContainer[] = [];
        const jniEnv = this.threads.getJNIEnv(threadId);

        this.updateState(data);

        if (!config.env || this.shouldIgnoreMethod(data)) {
            return;
        }

        outputArgs.push(new DataJSONContainer(jniEnv, null));

        let sendData = null;
        const argData = this.addJNIEnvArgs(data, outputArgs);
        const retData = this.addJNIEnvRet(data, outputRet);

        if (argData !== null && retData === null) {
            sendData = argData;
        } else if (argData == null && retData !== null) {
            sendData = retData;
        }

        this.sendToHost(
            "JNIEnv",
            data,
            outputArgs,
            outputRet[RET_INDEX],
            sendData,
            context
        );
    }

    private updateState(data: MethodData): void {
        const JARRAY_INDEX = 1;
        const name = data.method.name;

        if (name === "GetArrayLength") {
            this.byteArraySizes[data.args[JARRAY_INDEX].toString()]
                = data.ret as number;
        } if (name.startsWith("New") && name.endsWith("Array")) {
            this.byteArraySizes[data.ret.toString()]
                = data.args[JARRAY_INDEX] as number;
        }
    }

    private shouldIgnoreMethod(data: MethodData): boolean {
        const config = Config.getInstance();
        const include = config.include;
        const exclude = config.exclude;
        const name = data.method.name;

        if (include.length > EMPTY_ARRAY_LEN) {
            const included = include.filter(
                (i): boolean => new RegExp(i).test(name)
            );
            if (included.length === EMPTY_ARRAY_LEN) {
                return true;
            }
        }
        if (exclude.length > EMPTY_ARRAY_LEN) {
            const excluded = exclude.filter(
                (e): boolean => new RegExp(e).test(name)
            );
            if (excluded.length > EMPTY_ARRAY_LEN) {
                return true;
            }
        }

        return false;
    } 

    private addDefinceClassArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const CLASS_NAME_INDEX = 1;
        const OBJECT_INDEX = 2;
        const BUF_INDEX = 3;
        const LEN_INDEX = 4;

        const name = data.getArgAsPtr(CLASS_NAME_INDEX).readCString();
        outputArgs.push(
            new DataJSONContainer(data.args[CLASS_NAME_INDEX], name)
        );
        outputArgs.push(new DataJSONContainer(data.args[OBJECT_INDEX], null));
        const buf = data.getArgAsPtr(BUF_INDEX);
        const len = data.getArgAsNum(LEN_INDEX);
        const classData = buf.readByteArray(len);
        outputArgs.push(
            new DataJSONContainer(data.args[BUF_INDEX], null, BUF_INDEX)
        );
        outputArgs.push(
            new DataJSONContainer(data.args[LEN_INDEX], null)
        );
        return classData;
    }

    private addFindClassArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const CLASS_NAME_INDEX = 1;
        const name = data.getArgAsPtr(CLASS_NAME_INDEX).readCString();
        outputArgs.push(
            new DataJSONContainer(data.args[CLASS_NAME_INDEX], name)
        );
    }

    private addThrowNewArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const CLASS_INDEX = 1;
        const MESSAGE_INDEX = 2;

        const message = data.getArgAsPtr(MESSAGE_INDEX).readCString();
        outputArgs.push(new DataJSONContainer(data.args[CLASS_INDEX], null));
        outputArgs.push(
            new DataJSONContainer(data.args[MESSAGE_INDEX], message)
        );
    }

    private addFatalErrorArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const MESSAGE_INDEX = 1;
        const message = data.getArgAsPtr(MESSAGE_INDEX).readCString();
        outputArgs.push(
            new DataJSONContainer(data.args[MESSAGE_INDEX], message)
        );
    }

    private addGetGenericIDArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const CLASS_INDEX = 1;
        const NAME_INDEX = 2;
        const SIG_INDEX = 3;

        const name = data.getArgAsPtr(NAME_INDEX).readCString();
        const sig = data.getArgAsPtr(SIG_INDEX).readCString();

        outputArgs.push(new DataJSONContainer(data.args[CLASS_INDEX], null));
        outputArgs.push(new DataJSONContainer(data.args[NAME_INDEX], name));
        outputArgs.push(new DataJSONContainer(data.args[SIG_INDEX], sig));
    }

    private addNewStringArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const BUF_INDEX = 1;
        const LEN_INDEX = 2;
        const buf = data.getArgAsPtr(BUF_INDEX);
        const len = data.getArgAsNum(LEN_INDEX);
        const unicode = buf.readByteArray(len);

        outputArgs.push(new DataJSONContainer(
            data.args[BUF_INDEX], null, BUF_INDEX)
        );

        outputArgs.push(new DataJSONContainer(data.args[LEN_INDEX], null));

        return unicode;
    }

    private addGetGenericBufferArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const JARRAY_INDEX = 1;
        const BUF_INDEX = 2;

        outputArgs.push(new DataJSONContainer(data.args[JARRAY_INDEX], null));

        if (!data.getArgAsPtr(BUF_INDEX).isNull()) {
            outputArgs.push(
                new DataJSONContainer(
                    data.args[BUF_INDEX],
                    data.getArgAsPtr(BUF_INDEX).readS8()
                )
            );
        } else {
            outputArgs.push(new DataJSONContainer(
                data.args[BUF_INDEX], null
            ));
        }
    }

    private addReleaseCharsArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const JSTIRNG_INDEX = 2;
        const UNICODE_BUF_INDEX = 2;
        const unicode = data.getArgAsPtr(UNICODE_BUF_INDEX).readCString();
        outputArgs.push(
            new DataJSONContainer(data.args[JSTIRNG_INDEX], null)
        );
        outputArgs.push(
            new DataJSONContainer(data.args[UNICODE_BUF_INDEX], unicode)
        );
    }

    private addGetGenericBufferRegionArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const LAST_ARG_OFFSET = 1;
        const LEN_INDEX = 3;
        const BUF_INDEX = 4;

        const type = data.method.args[BUF_INDEX]
            .slice(TYPE_NAME_START, TYPE_NAME_END);
        const nType = Types.convertNativeJTypeToFridaType(type);
        const size = Types.sizeOf(nType);
        const buf = data.getArgAsPtr(BUF_INDEX);
        const len = data.getArgAsNum(LEN_INDEX);
        const region = buf.readByteArray(len * size);
        const loopLen = data.args.length - LAST_ARG_OFFSET;

        for (let i = SKIP_ENV_INDEX; i < loopLen; i++) {
            outputArgs.push(new DataJSONContainer(data.args[i], null));
        }
        outputArgs.push(
            new DataJSONContainer(
                data.args[data.args.length - LAST_ARG_OFFSET],
                null,
                data.args.length - LAST_ARG_OFFSET
            )
        );
        return region;
    }

    private addNewStringUTFArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const CHAR_PTR_INDEX = 1;
        const utf = data.getArgAsPtr(CHAR_PTR_INDEX).readUtf8String();
        outputArgs.push(
            new DataJSONContainer(data.args[CHAR_PTR_INDEX], utf)
        );
    }

    private addRegisterNativesArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const JCLASS_INDEX = 1;
        const METHODS_PTR_INDEX = 2;
        const SIZE_INDEX = 3;
        const JNI_METHOD_SIZE = 3;
        const size = data.getArgAsNum(SIZE_INDEX);
        const natives = [];

        outputArgs.push(new DataJSONContainer(data.args[JCLASS_INDEX], null));

        for (let i = 0; i < size * JNI_METHOD_SIZE; i += JNI_METHOD_SIZE) {
            const methodsPtr = data.getArgAsPtr(METHODS_PTR_INDEX);

            const namePtr = methodsPtr
                .add(i * Process.pointerSize)
                .readPointer();
            const name = namePtr.readCString();

            const sigOffset = 1;
            const sigPtr = methodsPtr
                .add((i + sigOffset) * Process.pointerSize)
                .readPointer();
            const sig = sigPtr.readCString();

            const addrOffset = 2;
            const addr = methodsPtr
                .add((i + addrOffset) * Process.pointerSize)
                .readPointer();

            natives.push(
                new NativeMethodJSONContainer(
                    {
                        value: namePtr.toString(),
                        data: name
                    },
                    {
                        value: sigPtr.toString(),
                        data: sig
                    },
                    {
                        value: addr.toString()
                    }
                )
            );
        }
        outputArgs.push(
            new DataJSONContainer(data.args[METHODS_PTR_INDEX], natives)
        );
        outputArgs.push(new DataJSONContainer(data.args[SIZE_INDEX], null));
    }

    private addGetJavaVMArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const JAVAVM_INDEX = 1;

        outputArgs.push(
            new DataJSONContainer(
                data.args[JAVAVM_INDEX],
                data.getArgAsPtr(JAVAVM_INDEX).readPointer()
            )
        );
    }

    private addReleaseStringCriticalArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const JSTRING_INDEX = 1;
        const JCHAR_PTR_INDEX = 2;

        outputArgs.push(
            new DataJSONContainer(data.args[JSTRING_INDEX], null)
        );
        outputArgs.push(
            new DataJSONContainer(
                data.args[JCHAR_PTR_INDEX],
                data.getArgAsPtr(JSTRING_INDEX).readCString()
            )
        );
    }

    private addReleaseElementsArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const BYTE_ARRAY_INDEX = 1;
        const BUFFER_PTR_INDEX = 2;
        const SKIP_ENV_INDEX = 1;

        const byteArrayArg = data.method.args[BYTE_ARRAY_INDEX];
        const type = byteArrayArg.slice(TYPE_NAME_START, TYPE_NAME_END);
        const nType = Types.convertNativeJTypeToFridaType(type);
        const size = Types.sizeOf(nType);
        const buf = data.getArgAsPtr(BUFFER_PTR_INDEX);
        const byteArray = data.getArgAsPtr(BYTE_ARRAY_INDEX).toString();
        const len = this.byteArraySizes[byteArray];

        let region = null;
        if (len !== undefined) {
            region = buf.readByteArray(len * size);
        }

        for (let i = SKIP_ENV_INDEX; i < data.args.length; i++) {
            const arg = data.args[i];
            let dataFor = undefined;

            if (i === BUFFER_PTR_INDEX) {
                dataFor = i;
            }

            outputArgs.push(
                new DataJSONContainer(arg, null, dataFor)
            );
        }

        return region;
    }

    private addGenericArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        for (let i = 1; i < data.args.length; i++) {
            outputArgs.push(
                new DataJSONContainer(data.args[i], null)
            );
        }
    }

    private addJNIEnvArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const name = data.method.name;

        if (name === "DefineClass") {
            return this.addDefinceClassArgs(data, outputArgs);
        } else if (name === "FindClass") {
            this.addFindClassArgs(data, outputArgs);
        } else if (name === "ThrowNew") {
            this.addThrowNewArgs(data, outputArgs);
        } else if (name === "FatalError") {
            this.addFatalErrorArgs(data, outputArgs);
        } else if (name.endsWith("ID")) {
            this.addGetGenericIDArgs(data, outputArgs);
        } else if (name === "NewString") {
            return this.addNewStringArgs(data, outputArgs);
        } else if (name.startsWith("Get") && name.endsWith("Chars") ||
                  name.startsWith("Get") && name.endsWith("Elements") ||
                  name.startsWith("Get") && name.endsWith("ArrayCritical") ||
                  name === "GetStringCritical") {
            this.addGetGenericBufferArgs(data, outputArgs);
        } else if (name.startsWith("Release") && name.endsWith("Chars")) {
            this.addReleaseCharsArgs(data, outputArgs);
        } else if (name.endsWith("Region")) {
            return this.addGetGenericBufferRegionArgs(data, outputArgs);
        } else if (name === "NewStringUTF") {
            this.addNewStringUTFArgs(data, outputArgs);
        } else if (name === "RegisterNatives") {
            this.addRegisterNativesArgs(data, outputArgs);
        } else if (name === "GetJavaVM") {
            this.addGetJavaVMArgs(data, outputArgs);
        } else if (name === "ReleaseStringCritical") {
            this.addReleaseStringCriticalArgs(data, outputArgs);
        } else if (name.startsWith("Release") && name.endsWith("Elements") ||
                name.startsWith("Release") && name.endsWith("ArrayCritical")) {
            return this.addReleaseElementsArgs(data, outputArgs);
        } else {
            this.addGenericArgs(data, outputArgs);
        }
        return null;
    }

    private addJNIEnvRet(
        data: MethodData,
        outputRet: DataJSONContainer[]
    ): ArrayBuffer | null {
        const RET_INDEX = -1;
        const ENVPTR_ARG_INDEX = 1;
        const name = data.method.name;

        if (name.startsWith("Get") && name.endsWith("Elements") ||
          name.startsWith("Get") && name.endsWith("ArrayCritical")) {
            const key = data.args[ENVPTR_ARG_INDEX].toString();

            if (this.byteArraySizes[key] !== undefined) {
                const type = data.method.ret.slice(
                    TYPE_NAME_START,
                    TYPE_NAME_END
                );
                const nType = Types.convertNativeJTypeToFridaType(type);
                const size = Types.sizeOf(nType);
                const buf = data.ret as NativePointer;
                const len = this.byteArraySizes[
                    data.getArgAsPtr(ENVPTR_ARG_INDEX).toString()
                ];

                outputRet.push(
                    new DataJSONContainer(
                        data.ret,
                        null,
                        RET_INDEX
                    )
                );

                return buf.readByteArray(len * size);
            }
        }
    
        outputRet.push(
            new DataJSONContainer(
                data.ret,
                null
            )
        );

        return null;
    }

    private addAttachCurrentThreadArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const ENV_ARG_INDEX = 1;
        const ARGS_ARG_INDEX = 2;
        const JINT_SIZE = 4;
        const argStructSize = Types.sizeOf("pointer") +
                                Types.sizeOf("pointer") +
                                JINT_SIZE;

        const threadId = Process.getCurrentThreadId();
        const env = data.args[ENV_ARG_INDEX];
        let envData = null;

        if (data.ret === JNI_OK) {
            envData = this.threads.getJNIEnv(threadId);
        } else if (!data.getArgAsPtr(ENV_ARG_INDEX).isNull()) {
            envData = data.getArgAsPtr(ENV_ARG_INDEX).readPointer();
        }

        outputArgs.push(new DataJSONContainer(env, envData));

        const argValue = data.args[ARGS_ARG_INDEX];

        if (!data.getArgAsPtr(ARGS_ARG_INDEX).isNull()) {
            outputArgs.push(new DataJSONContainer(
                argValue, null, ARGS_ARG_INDEX
            ));
            return data
                .getArgAsPtr(ARGS_ARG_INDEX)
                .readByteArray(argStructSize);
        } else {
            outputArgs.push(new DataJSONContainer(
                argValue, null
            ));
        }


        return null;
    }

    private addGetEnvArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): void {
        const ENV_ARG_INDEX = 1;
        const VERSION_ARG_INDEX = 2;

        const threadId = Process.getCurrentThreadId();
        const env: NativeArgumentValue = data.args[ENV_ARG_INDEX];
        let binData = null;

        if (data.ret === JNI_OK) {
            binData = this.threads.getJNIEnv(threadId);
        } else if (!data.getArgAsPtr(ENV_ARG_INDEX).isNull()) {
            binData = data.getArgAsPtr(ENV_ARG_INDEX).readPointer();
        }

        outputArgs.push(new DataJSONContainer(env, binData));
        outputArgs.push(new DataJSONContainer(
            data.args[VERSION_ARG_INDEX], null
        ));
    }

    private addJavaVMArgs(
        data: MethodData,
        outputArgs: DataJSONContainer[]
    ): ArrayBuffer | null {
        const name = data.method.name;

        if (name.startsWith("AttachCurrentThread")) {
            return this.addAttachCurrentThreadArgs(data, outputArgs);
        } else if (name === "GetEnv") {
            this.addGetEnvArgs(data, outputArgs);
        }

        return null;
    }

    private createBacktrace(
        context: CpuContext | NativePointer[],
        type: string
    ): BacktraceJSONContainer[] {
        let bt = context;

        if (!(bt instanceof Array)) {
            let backtraceType = null;
            if (type === "fuzzy") {
                backtraceType = Backtracer.FUZZY;
            } else {
                backtraceType = Backtracer.ACCURATE;
            }
            bt = Thread.backtrace(context as CpuContext, backtraceType);
        }

        return bt.map((addr): BacktraceJSONContainer => {
            return new BacktraceJSONContainer(
                addr,
                Process.findModuleByAddress(addr)
            );
        });
    }

    private sendToHost(
        type: string,
        data: MethodData,
        args: DataJSONContainer[],
        ret: DataJSONContainer,
        sendData: ArrayBuffer | null,
        context: CpuContext | NativePointer[]
    ): void {
        const config = Config.getInstance();
        const jParams = data.jParams;
        let backtrace = undefined;

        if (config.backtrace !== "none") {
            backtrace = this.createBacktrace(context, config.backtrace);
        }

        const output = new RecordJSONContainer(
            type,
            data.method,
            args,
            ret,
            Process.getCurrentThreadId(),
            Date.now() - this.start,
            jParams,
            backtrace
        );

        send(output, sendData);
    }
};

export { DataTransport };
