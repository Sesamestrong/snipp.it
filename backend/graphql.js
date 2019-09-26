module.exports = new Promise(async (resolve, reject) => {
  const mongoose = require("mongoose");
  const {
    ApolloServer,
    gql,
    SchemaDirectiveVisitor,
  } = require("apollo-server-express");
  const {
    defaultFieldResolver
  } = require("graphql");
  const jwt = require("jsonwebtoken");

  const ObjectId = mongoose.Types.ObjectId;
  ObjectId.prototype.valueOf = function() {
    return this.toString();
  };

  //Import models
  const {
    models: {
      User,
      Snip,
      UserRole
    },
    privateKey
  } = await require("./mongoose.js");

  const typeDefs = gql `
directive @role(role:Role) on FIELD_DEFINITION
directive @authenticated(isAuth:Boolean) on FIELD_DEFINITION

type Query {
  me: User
  user(username: String!): User
  validate(username: String!, password: String!): String
  snip(id: String!): Snip
  snips(query: SnipQuery!): [Snip]!
}

type Mutation{
  newUser(username: String!, password: String!): String @authenticated(isAuth:false)
  newSnip(name: String!, public:Boolean!): Snip @authenticated(isAuth:true)
  setUserRole(snipId:String!,username:String!,role:Role): UserRole @authenticated(isAuth:true)
  setSnipContent(snipId:String!,newContent:String!): String @authenticated(isAuth:true)
  deleteSnip(snipId:String!) @authenticated(isAuth:true)
}

type User {
  username: String!
  snips: [Snip]!
}

enum Role {
  OWNER
  EDITOR
  READER
}

type UserRole {
  user:User!
  role:Role
}

type Snip {
  id: String!
  name: String! @role(role:READER)
  content: String! @role(role:READER)
  owner: User! @role(role:READER)
  public: Boolean!
  users:[UserRole!]! @role(role:READER)
}
input SnipQuery {
  name: String
}

schema {
  query: Query
  mutation: Mutation
}
`;

  //Removes all undefined values from a graphql input query
  const graphqlToMongoose = query => (Object.keys(query).reduce((obj, key) => query[key] === undefined ? obj : { ...obj,
    [key]: query[key]
  }, {}));

  const authenticated = (bool = true) => next => (root, args, context, info) => {
    if ((!!(context._id)) == bool)
      return next(root, args, context, info);
    throw bool ? "Not authenticated." : "Already authenticated.";
  };
  class AuthenticatedDirective extends SchemaDirectiveVisitor {
    visitFieldDefinition(field) {
      const {
        resolve = defaultFieldResolver
      } = field;
      const {
        isAuth = true
      } = this.args;
      field.resolve = authenticated(isAuth)((...args) => resolve.call(this, ...args));
    }
  }

  const role = role => next => async (root, args, context, info) => {
    console.log("Looking for role", role);
    if (root.constructor.modelName !== "Snip") throw "Roles exist only for snips!";
    if (await root.userHasRole({
        role,
        _id: context._id
      }))
      return await next(root, args, context, info);
    throw `User does not have role ${role}.`;
  };

  class RoleDirective extends SchemaDirectiveVisitor {
    visitFieldDefinition(field) {
      const {
        resolve = defaultFieldResolver
      } = field;
      const {
        role: roleName
      } = this.args;
      field.resolve = role(roleName)((...args) => resolve.call(this, ...args));
    }
  }

  const resolvers = {
    Query: {
      me: (async (_, args, {
        _id
      }) => await User.findById(_id)),
      user: async (_, {
        username
      }) => await User.findOne({
        username
      }),
      validate: async (_, {
          username,
          password
        }) =>
        await (await User.validate({
          username,
          password
        })).genToken(),
      snip: async (root, {
        id
      }) => await Snip.findById(id),
      snips: async (root,{query:{name}},{_id}) => (await Promise.all((await Snip.find(graphqlToMongoose({name}))).map(snip=>snip.userHasRole({role:"READER",_id})?snip:null))).filter(i=>i),
    },
    Mutation: {
      newUser: (async (_, {
          username,
          password
        }) =>
        await (await User.create({
          username,
          password
        })).genToken()),
      newSnip: ((_, {
          name,
          public
        }, {
          _id
        }) =>
        Snip.create({
          name,
          public,
          _id
        })),
      setUserRole: (async (_, {
          snipId,
          username,
          role: roleName
        }, {
          _id
        }) =>

        await role("OWNER")(async (snip) => await snip.setUserRole({
          _id: (await User.findOne({
            username
          }))._id,
          role: roleName
        }))(await Snip.findById(snipId), null, {
          _id
        })
      ),
      setSnipContent: (async (_, {
          snipId,
          newContent
        }, {
          _id
        }) =>
        await role("OWNER")(async (snip) => (await snip.setContent({
          newContent
        })).content)(await Snip.findById(snipId), null, {
          _id
        })
      ),
      deleteSnip: (async (_,{snipId},{_id})=>await role("OWNER")(async (snip)=>{
          const owner=await User.findById(snip.ownerId);
          owner.snipIds=owner.snipIds.filter(id=>id!==snipId);
          await new Promise((resolve,reject)=>owner.save((err,owner)=>err||!owner?reject(err):resolve(owner)));
          await (Snip.findById(snipId).remove().exec());
      })(await Snip.findById(snipId),null,{_id})
      )
    },
    //Add more resolvers here
    User: {
      snips: (root) => Promise.all(root.snipIds.map(async snipId => await Snip.findById(snipId))),
    },
    Snip: {
      owner: (async (root) => await User.findById(root.ownerId)),
      //TODO fix User.findById(... returning null or undefined
      users: (async (root) => (await Promise.all(root.roleIds.map(async roleId => await UserRole.findById(roleId))))),
    },
    UserRole: {
      user: async (root) =>
        await User.findById(root.userId)
      ,
    },
  };

  const context = function({
    req
  }) {
    return new Promise((resolve, reject) => {
      const headers = req.headers;
      const auth = headers.authentication;
      jwt.verify(auth, privateKey, (err, info) => {
        resolve({
          auth,
          _id: !err && info._id
        });
      });
    });
  };

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context,
    schemaDirectives:{
      authenticated:AuthenticatedDirective,
      role:RoleDirective,
    },
  });

  resolve((app) => server.applyMiddleware({
    app
  }));
});
